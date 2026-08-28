/**
 * server/routes.ts — thin wrappers over ucp/ and size/.
 *
 * The browser calls these; it never talks to Shopify. Store negotiation is
 * cached briefly so repeated searches don't re-handshake.
 */

import { negotiateStore } from "../ucp/negotiate.js";
import { searchCatalog } from "../ucp/client.js";
import { UcpError } from "../ucp/types.js";
import type { NegotiatedStore, UcpProduct } from "../ucp/types.js";
import {
  loadDefaultSizeTable,
  estimateFootLength,
  type FitStatement as SizeFitStatement,
  type Gender,
  type SizeSystem,
} from "../size/resolver.js";

const table = loadDefaultSizeTable();

const SIZE_OPTION = /^(size|shoe\s*size|us\s*size|uk\s*size|eu\s*size)$/i;

// Small local brand list for search results — the fuller inference lives in
// ucp/probe.ts. Enough to feed recommend_size.
const KNOWN_BRANDS = [
  "nike", "air jordan", "jordan", "adidas", "new balance", "converse", "asics",
  "birkenstock", "salomon", "puma", "reebok", "vans", "hoka", "saucony", "brooks",
  "veja", "merrell", "ugg", "crocs", "maison margiela", "margiela", "common projects",
];

function inferBrand(p: UcpProduct): string {
  const title = p.title.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  for (const b of [...KNOWN_BRANDS].sort((a, z) => z.length - a.length)) {
    if (title === b || title.startsWith(b + " ")) {
      return b === "air jordan" ? "jordan" : b === "margiela" ? "maison margiela" : b;
    }
  }
  const tags = new Set((p.tags ?? []).map((t) => t.toLowerCase().replace(/[-_]+/g, " ").trim()));
  for (const b of KNOWN_BRANDS) if (tags.has(b)) return b;
  return "";
}

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

export async function routeSearch(body: { domain?: string; query?: string; limit?: number }) {
  const domain = (body.domain ?? "").trim();
  const query = (body.query ?? "").trim();
  if (!domain) throw new HttpError(400, "domain is required");
  if (!query) throw new HttpError(400, "query is required");

  const store = await getStore(domain);
  const res = await searchCatalog(store, {
    query,
    context: { address_country: "CA", currency: "CAD", language: "en" },
    pagination: { limit: Math.min(Math.max(body.limit ?? 12, 1), 40) },
  });

  const products = (res.products ?? []).map((p) => {
    const opt = (p.options ?? []).find((o) => SIZE_OPTION.test(o.name.trim()));
    return {
      id: p.id,
      title: p.title,
      brand: inferBrand(p),
      url: p.url,
      sizeOptionName: opt?.name ?? null,
      sizeLabels: opt
        ? [...new Set(opt.values.map((v) => v.label.trim()))].sort((a, b) => {
            const na = Number.parseFloat(a);
            const nb = Number.parseFloat(b);
            return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : a.localeCompare(b);
          })
        : [],
    };
  });

  return { domain: store.domain, query, count: products.length, products };
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
