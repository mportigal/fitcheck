/**
 * server/routes.ts — thin wrappers over ucp/ and size/.
 *
 * The browser calls these; it never talks to Shopify. Store negotiation is
 * cached briefly so repeated searches don't re-handshake.
 */

import { negotiateStore } from "../ucp/negotiate.js";
import { getProduct, searchCatalog, type OptionValueSignal } from "../ucp/client.js";
import { inferBrand } from "../ucp/brand.js";
import { UcpError } from "../ucp/types.js";
import type { NegotiatedStore, UcpProduct, UcpVariant } from "../ucp/types.js";
import {
  loadDefaultSizeTable,
  estimateFootLength,
  type FitStatement as SizeFitStatement,
  type Gender,
  type SizeSystem,
} from "../size/resolver.js";
import {
  checkFit,
  detectTitleGender,
  inferNumberingSystem,
  targetSize,
  type SizeAvailability,
} from "../size/fit.js";

const table = loadDefaultSizeTable();

const SIZE_OPTION = /^(size|shoe\s*size|us\s*size|uk\s*size|eu\s*size)$/i;

// Brand inference is shared with ucp/probe.ts (ucp/brand.ts): title prefix, then
// tags, then model name. It returns null for "no brand"; here that's "".
const brandOf = (p: UcpProduct): string => inferBrand(p).brand ?? "";

// -------------------------------------------------------------- store cache

const NEGOTIATE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { store: NegotiatedStore; at: number }>();

async function getStore(domain: string): Promise<NegotiatedStore> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < NEGOTIATE_TTL_MS) return hit.store;
  const store = await negotiateStore(domain, { allowRedirects: true });
  cache.set(domain, { store, at: Date.now() });
  return store;
}

// -------------------------------------------------------------- route bodies

export async function routeNegotiate(body: { domain?: string }) {
  const domain = (body.domain ?? "").trim();
  if (!domain) throw new HttpError(400, "domain is required");
  const store = await getStore(domain);
  return {
    domain: store.domain,
    protocolVersion: store.protocolVersion,
    transport: store.transport,
    endpoint: store.endpoint,
    capabilities: Object.fromEntries(
      Object.values(store.capabilities).map((c) => [c.name, c.version]),
    ),
    warnings: store.warnings,
  };
}

function sortSizeLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((a, b) => {
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : a.localeCompare(b);
  });
}

export async function routeSearch(body: {
  domain?: string;
  query?: string;
  limit?: number;
  /** When present, every product comes back with a fit verdict (labels-only — no stock check). */
  footLengthMm?: number;
  gender?: string;
}) {
  const domain = (body.domain ?? "").trim();
  const query = (body.query ?? "").trim();
  if (!domain) throw new HttpError(400, "domain is required");
  if (!query) throw new HttpError(400, "query is required");

  const footLengthMm = Number.isFinite(Number(body.footLengthMm)) ? Number(body.footLengthMm) : null;
  const gender = body.gender === "women" ? "women" : body.gender === "men" ? "men" : null;

  const store = await getStore(domain);
  const res = await searchCatalog(store, {
    query,
    context: { address_country: "CA", currency: "CAD", language: "en" },
    pagination: { limit: Math.min(Math.max(body.limit ?? 12, 1), 40) },
  });

  const products = (res.products ?? []).map((p) => {
    const opt = (p.options ?? []).find((o) => SIZE_OPTION.test(o.name.trim()));
    const brand = brandOf(p);
    const sizeLabels = opt ? sortSizeLabels(opt.values.map((v) => v.label.trim())) : [];
    return {
      id: p.id,
      title: p.title,
      brand,
      url: p.url,
      sizeOptionName: opt?.name ?? null,
      sizeLabels,
      // Labels-only verdict: no getProduct call, so no stock/exists check here.
      // check_fit(productId) does the deeper read.
      fit:
        footLengthMm != null
          ? checkFit({ brand, gender, footLengthMm, runLabels: sizeLabels, title: p.title }, table)
          : undefined,
    };
  });

  const scanned = products.length;
  const matched = products.filter((p) => p.fit?.verdict === "fits").length;
  return { domain: store.domain, query, scanned, matched, count: scanned, products };
}

// -------------------------------------------------------------- check_fit

/**
 * Build a per-size availability map for a product. Uses `available`/`exists` on
 * the option values when the store provides them; otherwise probes the target
 * and its listed neighbours with `get_product?selected=`, joining against the
 * returned variant. Kith returns 0 variants for both sold-out and never-made
 * sizes, so that case reads as unavailable rather than as exists:false.
 */
async function resolveAvailability(
  store: NegotiatedStore,
  productId: string,
  sizeOptionName: string,
  runLabels: string[],
  interestingNums: number[],
): Promise<Record<number, SizeAvailability>> {
  const out: Record<number, SizeAvailability> = {};
  const labelFor = (n: number) =>
    runLabels.find((l) => Number.parseFloat(l) === n) ?? String(n);

  await Promise.all(
    interestingNums.map(async (n) => {
      try {
        const res = await getProduct(store, productId, {
          selected: [{ name: sizeOptionName, label: labelFor(n) }],
        });
        const variants = (res.product?.variants ?? []) as UcpVariant[];
        const hit = variants.find((v) =>
          (v.options ?? []).some(
            (o) => o.name === sizeOptionName && Number.parseFloat(o.label) === n,
          ),
        );
        if (hit) {
          out[n] = { exists: true, available: hit.availability?.available !== false };
        } else {
          const listed = runLabels.some((l) => Number.parseFloat(l) === n);
          out[n] = { exists: listed, available: false };
        }
      } catch {
        // leave unknown
      }
    }),
  );
  return out;
}

export async function routeCheckFit(body: {
  domain?: string;
  productId?: string;
  footLengthMm?: number;
  gender?: string;
}) {
  const domain = (body.domain ?? "").trim();
  const productId = (body.productId ?? "").trim();
  if (!domain) throw new HttpError(400, "domain is required");
  if (!productId) throw new HttpError(400, "productId is required");

  const footLengthMm = Number.isFinite(Number(body.footLengthMm)) ? Number(body.footLengthMm) : null;
  const gender = body.gender === "women" ? "women" : body.gender === "men" ? "men" : null;

  const store = await getStore(domain);
  const res = await getProduct(store, productId);
  const product = res.product;
  if (!product) throw new HttpError(404, `no product ${productId}`);

  const brand = brandOf(product);
  const opt = (product.options ?? []).find((o) => SIZE_OPTION.test(o.name.trim()));
  const runLabels = opt ? sortSizeLabels(opt.values.map((v) => v.label.trim())) : [];

  // If option values already carry availability, use them directly.
  const signalAvail: Record<number, SizeAvailability> = {};
  for (const v of (opt?.values ?? []) as OptionValueSignal[]) {
    const n = Number.parseFloat(v.label);
    if (Number.isFinite(n) && (v.available !== undefined || v.exists !== undefined)) {
      signalAvail[n] = { exists: v.exists !== false, available: v.available !== false };
    }
  }

  let availability = signalAvail;
  if (Object.keys(signalAvail).length === 0 && opt && footLengthMm != null && brand) {
    // Probe the same size checkFit will target, plus its listed neighbours.
    const g = gender ?? detectTitleGender(product.title) ?? "men";
    const tgt = targetSize(table, brand, g, footLengthMm);
    const sys = inferNumberingSystem(runLabels);
    const target = tgt ? (sys === "eu" ? tgt.eu : tgt.us) : undefined;
    const runNums = [...new Set(runLabels.map((l) => Number.parseFloat(l)).filter(Number.isFinite))].sort(
      (a, b) => a - b,
    );
    const interesting = new Set<number>();
    if (typeof target === "number") {
      interesting.add(target);
      const below = [...runNums].reverse().filter((n) => n < target).slice(0, 2);
      const above = runNums.filter((n) => n > target).slice(0, 2);
      for (const n of [...below, ...above]) interesting.add(n);
    }
    availability = await resolveAvailability(
      store,
      productId,
      opt.name,
      runLabels,
      [...interesting],
    );
  }

  const verdict = checkFit(
    { brand, gender, footLengthMm, runLabels, availability, title: product.title },
    table,
  );
  return {
    productId,
    title: product.title,
    url: product.url,
    brand,
    ...verdict,
  };
}

// -------------------------------------------------------------- check_labels

/**
 * Same verdict as check_fit, but the caller hands over the Size run itself —
 * for an agent already on the product page that can read the option labels.
 * No negotiate, no get_product, no availability probe: this route never
 * touches a store. A stock-driven verdict (`out_of_stock`) therefore can't
 * arise here; every other verdict (`fits` / `size_up` / `between_sizes` /
 * `no_size` / `unmapped_brand` / `unknown`) is label-and-profile only.
 */
export function routeCheckLabels(body: {
  brand?: string;
  labels?: unknown;
  title?: string;
  footLengthMm?: number;
  gender?: string;
}) {
  const brand = (body.brand ?? "").trim();
  const labels = Array.isArray(body.labels)
    ? body.labels.map((l) => String(l).trim()).filter(Boolean)
    : [];
  if (!brand) throw new HttpError(400, "brand is required");
  if (labels.length === 0) throw new HttpError(400, "labels must be a non-empty array");

  const footLengthMm = Number.isFinite(Number(body.footLengthMm)) ? Number(body.footLengthMm) : null;
  const gender = body.gender === "women" ? "women" : body.gender === "men" ? "men" : null;
  const title = (body.title ?? "").trim() || undefined;

  const runLabels = sortSizeLabels(labels);
  const verdict = checkFit({ brand, gender, footLengthMm, runLabels, title }, table);
  return { brand, title: title ?? null, runLabels, ...verdict };
}

// -------------------------------------------------------------- find_shoe

/** Stores find_shoe fans out to. Hardcoded — this isn't a directory. */
const FIND_STORES: ReadonlyArray<{ domain: string; label: string }> = [
  { domain: "kith.com", label: "Kith" },
  { domain: "stompingground.myshopify.com", label: "Stomping Ground" },
];

const FIND_STORE_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type SearchProduct = Awaited<ReturnType<typeof routeSearch>>["products"][number];
type FoundProduct = SearchProduct & { store: string; storeDomain: string };

/**
 * Search every store in FIND_STORES at once and merge the hits, so the caller
 * can ask for a shoe instead of a store. Reuses routeSearch per store — no
 * re-implemented negotiation or resolution.
 *
 * Deliberately NOT deduplicated across stores: the same shoe has a different
 * product id and a different title at each retailer, with no shared key to join
 * on (the same catalog-topology gap the store recon turned up). Both rows are
 * returned, each tagged with its store.
 */
export async function routeFindShoe(body: { query?: string; footLengthMm?: number; gender?: string }) {
  const query = (body.query ?? "").trim();
  if (!query) throw new HttpError(400, "query is required");

  const footLengthMm = Number.isFinite(Number(body.footLengthMm)) ? Number(body.footLengthMm) : undefined;
  const gender = body.gender === "women" ? "women" : body.gender === "men" ? "men" : undefined;

  // Parallel, not sequential — latency is the risk. One store failing or timing
  // out is reported, not fatal.
  const settled = await Promise.allSettled(
    FIND_STORES.map((s) =>
      withTimeout(routeSearch({ domain: s.domain, query, footLengthMm, gender }), FIND_STORE_TIMEOUT_MS, s.label),
    ),
  );

  const stores: Array<{
    label: string;
    domain: string;
    scanned: number;
    matched: number;
    ok: boolean;
    error?: string;
  }> = [];
  const merged: FoundProduct[] = [];

  settled.forEach((r, i) => {
    const meta = FIND_STORES[i];
    if (r.status === "fulfilled") {
      stores.push({ label: meta.label, domain: meta.domain, scanned: r.value.scanned, matched: r.value.matched, ok: true });
      for (const p of r.value.products) merged.push({ ...p, store: meta.label, storeDomain: meta.domain });
    } else {
      stores.push({
        label: meta.label,
        domain: meta.domain,
        scanned: 0,
        matched: 0,
        ok: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  // fits first, then everything else. Stable sort, and stores were merged in
  // FIND_STORES order, so per-store relevance order is kept within each group.
  const notFit = (p: FoundProduct) => (p.fit?.verdict === "fits" ? 0 : 1);
  merged.sort((a, b) => notFit(a) - notFit(b));

  return { query, stores, products: merged };
}

interface EstimateBody {
  statements?: Array<{ brand?: string; gender?: string; system?: string; value?: number }>;
}

export function routeEstimate(body: EstimateBody) {
  const raw = body.statements ?? [];
  const fits: SizeFitStatement[] = [];
  for (const s of raw) {
    const brand = (s.brand ?? "").trim();
    const value = Number(s.value);
    const gender = (s.gender ?? "men") as Gender;
    const system = (s.system ?? "us") as SizeSystem;
    if (!brand || !Number.isFinite(value)) continue;
    if (gender !== "men" && gender !== "women") continue;
    if (system !== "us" && system !== "uk" && system !== "eu") continue;
    fits.push({ brand, gender, system, value });
  }

  if (fits.length === 0) {
    return { status: "empty" as const, resolved: [] };
  }

  const est = estimateFootLength(table, fits);
  const conflictNote =
    est.status === "conflict" ? est.warnings[0] ?? "fit statements disagree" : undefined;

  return {
    status: est.status,
    low: est.low,
    high: est.high,
    bestMm: est.bestMm,
    spreadMm: est.spreadMm,
    conflictNote,
    resolved: est.resolved.map((r, index) => ({
      index,
      footLengthMm: r.footLengthMm,
      status: r.status,
      note: r.warnings[0],
    })),
  };
}

export function routeRecommend(body: {
  brand?: string;
  gender?: string;
  footLengthMm?: number;
}) {
  const brand = (body.brand ?? "").trim();
  const gender = (body.gender ?? "men") as Gender;
  const footLengthMm = Number(body.footLengthMm);
  if (!brand) throw new HttpError(400, "brand is required");
  if (!Number.isFinite(footLengthMm)) throw new HttpError(400, "footLengthMm is required");
  if (gender !== "men" && gender !== "women") throw new HttpError(400, "gender must be men or women");

  const r = table.recommend({ brand, gender, footLengthMm });
  return {
    status: r.status,
    us: r.us,
    uk: r.uk,
    eu: r.eu,
    sizeLengthMm: r.sizeLengthMm,
    headroomMm: r.headroomMm,
    label: r.label,
    reason: r.reason,
  };
}

// -------------------------------------------------------------- errors

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function toHttp(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof UcpError) return { status: 502, message: `${err.code}: ${err.message}` };
  return { status: 500, message: err instanceof Error ? err.message : "internal error" };
}
