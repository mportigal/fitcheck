/**
 * UCP discovery + negotiation.
 *
 * Flow, per spec:
 *   1. Fetch the business profile from https://{domain}/.well-known/ucp
 *   2. Resolve the protocol version (falling back through supported_versions)
 *   3. Intersect capabilities by name AND version, select the highest mutual
 *   4. Prune extensions whose parents didn't survive, repeat until stable
 *   5. Resolve a transport binding + endpoint from services["dev.ucp.shopping"]
 *
 * Step 3 is the one that bites: a capability with no mutual version is silently
 * excluded rather than erroring, so a version mismatch looks like "this store
 * doesn't do search" instead of "we advertised the wrong date".
 */

import {
  NegotiatedCapability,
  NegotiatedStore,
  UcpEntity,
  UcpError,
  UcpProfile,
  UcpService,
} from "./types.js";

import platformProfileJson from "./platform-profile.json" with { type: "json" };

const PLATFORM_PROFILE = platformProfileJson as unknown as UcpProfile;

/**
 * Public URL where platform-profile.json is served. Sent on every request.
 *
 * Default is the repo copy via jsDelivr, which serves it as
 * `application/json`. Do NOT point this at raw.githubusercontent.com — that
 * host sends `text/plain` and Shopify rejects it with
 * `profile_malformed: Invalid content type` (confirmed 2026-08-28). jsDelivr
 * caches a floating `@main` ref for ~12h at the edge; pin `@<commit-sha>` for
 * an immutable URL, or purge via
 * https://purge.jsdelivr.net/gh/mportigal/fitcheck@main/ucp/platform-profile.json
 */
export const PLATFORM_PROFILE_URL =
  process.env.UCP_PLATFORM_PROFILE_URL ??
  "https://cdn.jsdelivr.net/gh/mportigal/fitcheck@main/ucp/platform-profile.json";

const SHOPPING_SERVICE = "dev.ucp.shopping";
export const CATALOG_SEARCH = "dev.ucp.shopping.catalog.search";
export const CATALOG_LOOKUP = "dev.ucp.shopping.catalog.lookup";

// ---------------------------------------------------------------- versions

/**
 * Versions are "YYYY-MM-DD" or the literal "draft". Dated versions always beat
 * "draft"; "draft" is used only when it's the sole mutual option.
 */
export function compareVersions(a: string, b: string): number {
  const aDraft = a === "draft";
  const bDraft = b === "draft";
  if (aDraft && bDraft) return 0;
  if (aDraft) return -1;
  if (bDraft) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function highestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions).pop();
}

// ---------------------------------------------------------------- fetching

interface CacheEntry {
  profile: UcpProfile;
  expiresAt: number;
}
const profileCache = new Map<string, CacheEntry>();

export interface FetchProfileOptions {
  timeoutMs?: number;
  /**
   * The spec says not to follow redirects on profile fetches. Real stores often
   * redirect apex -> www, so this is an opt-in escape hatch that records a warning.
   */
  allowRedirects?: boolean;
  noCache?: boolean;
}

export function wellKnownUrl(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host || host.includes("/")) {
    throw new UcpError(`Bad store domain: ${domain}`, "invalid_profile_url");
  }
  return `https://${host}/.well-known/ucp`;
}

export async function fetchProfile(
  url: string,
  opts: FetchProfileOptions = {},
): Promise<{ profile: UcpProfile; warnings: string[] }> {
  const warnings: string[] = [];

  if (!opts.noCache) {
    const hit = profileCache.get(url);
    if (hit && hit.expiresAt > Date.now()) return { profile: hit.profile, warnings };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: opts.allowRedirects ? "follow" : "manual",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new UcpError(`Could not fetch ${url}`, "profile_unreachable", err);
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new UcpError(
      `${url} redirected (${res.status}); spec forbids following redirects on profile ` +
        `fetches. Retry with allowRedirects if you trust the destination.`,
      "profile_unreachable",
    );
  }
  if (!res.ok) {
    throw new UcpError(`${url} returned ${res.status}`, "profile_unreachable");
  }
  if (opts.allowRedirects && res.redirected) {
    warnings.push(`Profile fetch followed a redirect to ${res.url}`);
  }

  let profile: UcpProfile;
  try {
    profile = (await res.json()) as UcpProfile;
  } catch (err) {
    throw new UcpError(`${url} is not valid JSON`, "profile_malformed", err);
  }

  if (!profile?.ucp || typeof profile.ucp.version !== "string") {
    throw new UcpError(`${url} has no ucp.version`, "profile_malformed", profile);
  }
  if (!profile.ucp.services) warnings.push("Profile omits required ucp.services");
  if (!profile.ucp.payment_handlers) {
    warnings.push("Profile omits required ucp.payment_handlers");
  }

  profileCache.set(url, {
    profile,
    expiresAt: Date.now() + parseMaxAge(res.headers.get("cache-control")),
  });

  return { profile, warnings };
}

function parseMaxAge(header: string | null): number {
  const m = header?.match(/max-age=(\d+)/);
  const seconds = m ? Number(m[1]) : 900;
  return Math.min(Math.max(seconds, 60), 86_400) * 1000;
}

// ---------------------------------------------------------------- protocol version

/**
 * We can talk to any protocol version whose capability shapes we parse. If the
 * business advertises something we don't list, try supported_versions for a
 * version-specific profile before giving up.
 */
async function resolveProtocolVersion(
  profile: UcpProfile,
  profileUrl: string,
  opts: FetchProfileOptions,
): Promise<{ profile: UcpProfile; profileUrl: string; version: string; warnings: string[] }> {
  const ours = new Set(
    Object.values(PLATFORM_PROFILE.ucp.capabilities ?? {})
      .flat()
      .map((e) => e.version),
  );
  ours.add(PLATFORM_PROFILE.ucp.version);

  const advertised = profile.ucp.version;
  if (ours.has(advertised)) {
    return { profile, profileUrl, version: advertised, warnings: [] };
  }

  const supported = profile.ucp.supported_versions ?? {};
  const candidate = highestVersion(Object.keys(supported).filter((v) => ours.has(v)));

  if (!candidate) {
    // Not fatal on its own — capability-level intersection may still succeed.
    return {
      profile,
      profileUrl,
      version: advertised,
      warnings: [
        `Store advertises protocol ${advertised}, which we don't list. Proceeding ` +
          `anyway; add it to platform-profile.json if catalog negotiation fails.`,
      ],
    };
  }

  const alt = await fetchProfile(supported[candidate], opts);
  return {
    profile: alt.profile,
    profileUrl: supported[candidate],
    version: candidate,
    warnings: [
      `Store's current protocol is ${advertised}; fell back to ${candidate}.`,
      ...alt.warnings,
    ],
  };
}

// ---------------------------------------------------------------- intersection

function parents(entry: UcpEntity): string[] {
  if (!entry.extends) return [];
  return Array.isArray(entry.extends) ? entry.extends : [entry.extends];
}

/**
 * Spec intersection algorithm:
 *   1. keep business capabilities whose name we also declare
 *   2. select the highest version present in BOTH arrays; empty set -> exclude
 *   3. drop extensions where none of their parents survived
 *   4. repeat 3 until stable
 */
export function intersectCapabilities(
  business: UcpProfile,
  platform: UcpProfile = PLATFORM_PROFILE,
  protocolVersion?: string,
): Record<string, NegotiatedCapability> {
  const bizCaps = business.ucp.capabilities ?? {};
  const platCaps = platform.ucp.capabilities ?? {};
  const out: Record<string, NegotiatedCapability> = {};

  for (const [name, bizEntries] of Object.entries(bizCaps)) {
    const platEntries = platCaps[name];
    if (!platEntries?.length || !bizEntries?.length) continue;

    const platVersions = new Set(platEntries.map((e) => e.version));
    const mutual = bizEntries.map((e) => e.version).filter((v) => platVersions.has(v));

    const selected = highestVersion(mutual);
    if (!selected) continue; // no mutual version -> excluded, silently, per spec

    const entry = bizEntries.find((e) => e.version === selected)!;

    // Entries can demand a protocol floor/ceiling, e.g. dev.shopify.catalog
    // requires protocol min 2026-04-08.
    const req = entry.requires?.protocol;
    if (protocolVersion && req) {
      if (req.min && compareVersions(protocolVersion, req.min) < 0) continue;
      if (req.max && compareVersions(protocolVersion, req.max) > 0) continue;
    }

    out[name] = { name, version: selected, entry };
  }

  // Prune orphaned extensions until the set stops shrinking.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cap] of Object.entries(out)) {
      const ps = parents(cap.entry);
      if (ps.length > 0 && !ps.some((p) => p in out)) {
        delete out[name];
        changed = true;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------- transport

/**
 * Pick a callable transport. REST first: OpenAPI paths append straight onto
 * `endpoint`, so `POST {endpoint}/catalog/search` and we're done. MCP needs a
 * JSON-RPC envelope and possibly a session handshake.
 */
export function resolveTransport(
  profile: UcpProfile,
): { transport: "rest" | "mcp"; endpoint: string; service: UcpService } {
  const services = profile.ucp.services?.[SHOPPING_SERVICE] ?? [];
  const callable = services.filter(
    (s): s is UcpService & { endpoint: string } =>
      (s.transport === "rest" || s.transport === "mcp") && typeof s.endpoint === "string",
  );

  if (callable.length === 0) {
    throw new UcpError(
      `Store advertises no REST or MCP binding for ${SHOPPING_SERVICE}`,
      "no_transport",
      services,
    );
  }

  const rest = callable.find((s) => s.transport === "rest");
  const chosen = rest ?? callable[0];
  return {
    transport: chosen.transport as "rest" | "mcp",
    endpoint: chosen.endpoint.replace(/\/+$/, ""),
    service: chosen,
  };
}

// ---------------------------------------------------------------- entry point

export async function negotiateStore(
  domain: string,
  opts: FetchProfileOptions = {},
): Promise<NegotiatedStore> {
  const initialUrl = wellKnownUrl(domain);
  const first = await fetchProfile(initialUrl, opts);
  const resolved = await resolveProtocolVersion(first.profile, initialUrl, opts);

  const warnings = [...first.warnings, ...resolved.warnings];
  const capabilities = intersectCapabilities(
    resolved.profile,
    PLATFORM_PROFILE,
    resolved.version,
  );

  if (!(CATALOG_SEARCH in capabilities) && !(CATALOG_LOOKUP in capabilities)) {
    const advertised = Object.entries(resolved.profile.ucp.capabilities ?? {})
      .map(([n, es]) => `${n}@[${es.map((e) => e.version).join(",")}]`)
      .join(" ");
    throw new UcpError(
      `No mutual catalog capability with ${domain}. Store advertises: ${advertised || "(none)"}. ` +
        `Add the missing version to platform-profile.json.`,
      "capabilities_incompatible",
    );
  }
  if (!(CATALOG_SEARCH in capabilities)) {
    warnings.push("No mutual catalog.search — lookup only, browse flows will not work.");
  }

  const { transport, endpoint } = resolveTransport(resolved.profile);
  if (transport === "mcp") {
    warnings.push("Store offers MCP only; request envelope is less well-verified than REST.");
  }

  return {
    domain,
    profileUrl: resolved.profileUrl,
    protocolVersion: resolved.version,
    transport,
    endpoint,
    capabilities,
    warnings,
    raw: resolved.profile,
  };
}
