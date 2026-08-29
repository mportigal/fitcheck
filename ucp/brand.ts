/**
 * ucp/brand.ts — brand inference from a UCP product. One copy, shared by
 * ucp/probe.ts (the offline report) and server/routes.ts (the live path).
 *
 * A retailer only has to put the brand *somewhere*; plenty drop it from the
 * title and never tag it. Resolution order, most to least reliable:
 *
 *   1. brand name is a title prefix        -> source "title"
 *   2. brand name is a product tag         -> source "tag"
 *   3. a model name gives the brand away   -> source "model"
 *   4. nothing matched                     -> brand null, source "none"
 */

import type { UcpProduct } from "./types.js";

/**
 * Brands we can *recognise* in a title, tag, or (via MODEL_*) a model name.
 * A superset of the seven that size/resolver.ts maps, so coverage math can tell
 * "unmapped brand" (Veja) apart from "no brand found".
 */
export const KNOWN_BRANDS = [
  "nike", "air jordan", "jordan", "adidas", "new balance", "converse", "asics", "birkenstock",
  "salomon", "puma", "reebok", "vans", "hoka", "on running", "saucony", "brooks", "mizuno",
  "veja", "norda", "merrell", "ugg", "crocs", "clarks", "dr martens", "timberland",
  "maison margiela", "margiela", "common projects", "autry", "diadora", "onitsuka tiger",
  "moon boot", "stepney workers club", "wales bonner",
];

/** Normalise for comparison: lower-case, `-`/`_` -> space, collapse whitespace. */
export const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** Collapse spelling variants onto one canonical brand key. */
export function canonBrand(b: string): string {
  if (b === "air jordan") return "jordan";
  if (b === "margiela") return "maison margiela";
  if (b === "on running") return "on";
  return b;
}

/**
 * Model name -> brand, for retailers that drop the brand from the title
 * (Stomping Ground lists "Killshot 2", not "Nike Killshot 2"). New Balance model
 * codes are regular enough for a rule; Nike needs an explicit list. Veja is here
 * with no size map so its products read "veja (model, unmapped)" rather than
 * "no brand detected" — a recognised brand we choose not to resolve.
 *
 * Matched against the normalised title.
 */
const MODEL_RULES: ReadonlyArray<readonly [brand: string, test: RegExp]> = [
  // U1906F, U992NY, U990IC4, U2010TTB, M990, W880, ...
  ["new balance", /^[umw]\d{3,4}/],
];

const MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  nike: ["killshot 2", "air force 1", "air griffey max 1"],
  veja: ["esplar", "campo", "v 90"],
};

function inferModelBrand(title: string): string | null {
  for (const [brand, models] of Object.entries(MODEL_ALIASES)) {
    if (models.some((m) => title === m || title.startsWith(m + " "))) return brand;
  }
  for (const [brand, test] of MODEL_RULES) {
    if (test.test(title)) return brand;
  }
  return null;
}

export type BrandSource = "title" | "tag" | "model" | "none";

/**
 * Infer a product's brand. `brand` is null when nothing matched — callers apply
 * their own sentinel (probe prints "?", the server treats it as unmapped).
 */
export function inferBrand(p: UcpProduct): { brand: string | null; source: BrandSource } {
  const byLen = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  const title = norm(p.title);
  for (const b of byLen) if (title === b || title.startsWith(b + " ")) return { brand: canonBrand(b), source: "title" };

  const tags = new Set((p.tags ?? []).map(norm));
  for (const b of byLen) if (tags.has(b)) return { brand: canonBrand(b), source: "tag" };

  // Last resort: brand is gone from the title and tags, but the model name
  // still gives it away.
  const model = inferModelBrand(title);
  if (model) return { brand: canonBrand(model), source: "model" };

  return { brand: null, source: "none" };
}
