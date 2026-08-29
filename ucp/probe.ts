/**
 * Day-1 probe.
 *
 *   npx tsx ucp/probe.ts kith.com stompingground.example --query "t-shirt"
 *
 * Answers the two questions that decide the rest of the week:
 *
 *   1. What do these stores actually advertise? (protocol version, catalog
 *      capability versions, transports) — so platform-profile.json can be
 *      corrected before anything is built on top of it.
 *
 *   2. How often is size data actually there? For each variant it reports whether
 *      the size came from variant.options, from product.options, or had to be
 *      parsed out of the required `title` — and how often it's simply absent.
 *      That ratio sizes the normalizer, which is the real work of this project.
 *
 *   3. Per product: inferred brand, gender, category, and the full Size run —
 *      then products grouped by inferred numbering system (EU vs US/UK). A bare
 *      label like "7" is ambiguous across US men's / UK men's / US women's (a
 *      ~15-20mm spread). The system has to be inferred from the whole run plus
 *      brand and category, not from the label. Also reports which brands the
 *      catalog actually contains, and how many are among the seven size/ maps —
 *      if most sneakers are outside those seven, most fit verdicts come back
 *      unmapped and the demo needs a different store or query.
 *
 * It also dumps one raw product per store to ./probe-output/, because the fastest
 * way to find a merchant's custom metadata fields is to read one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { negotiateStore, CATALOG_SEARCH } from "./negotiate.js";
import { searchCatalog } from "./client.js";
import type { NegotiatedStore, UcpProduct, UcpVariant } from "./types.js";

const OUT_DIR = "./probe-output";

// Names that plausibly mean "size". Freeform in the spec, so this list is a
// hypothesis to be corrected by what the probe actually finds.
const SIZE_NAME = /^(size|shoe\s*size|us\s*size|uk\s*size|eu\s*size|talla|taille|größe|waist|length|inseam)$/i;

type SizeSource = "variant.options" | "product.options" | "title" | "absent";

interface SizeHit {
  source: SizeSource;
  optionName?: string;
  label?: string;
}

/**
 * Resolution chain, in order of trustworthiness. Only `title` is required by the
 * spec, so it is the floor — and "Blue / Large" is a convention, not a contract.
 */
export function resolveSize(product: UcpProduct, variant: UcpVariant): SizeHit {
  const direct = variant.options?.find((o) => SIZE_NAME.test(o.name.trim()));
  if (direct?.label) {
    return { source: "variant.options", optionName: direct.name, label: direct.label };
  }

  // Product declares a Size option but the variant didn't echo a selection:
  // recover the value by matching a known label against the variant title.
  const productSize = product.options?.find((o) => SIZE_NAME.test(o.name.trim()));
  if (productSize) {
    const parts = variant.title.split("/").map((s) => s.trim());
    const hit = productSize.values.find((v) =>
      parts.some((p) => p.toLowerCase() === v.label.trim().toLowerCase()),
    );
    if (hit) {
      return { source: "product.options", optionName: productSize.name, label: hit.label };
    }
  }

  // Last resort: guess from the title's slash-delimited segments.
  const parts = variant.title.split("/").map((s) => s.trim()).filter(Boolean);
  const guess = parts.find((p) =>
    /^(xxs|xs|s|m|l|xl|xxl|xxxl|\d{1,2}(\.\d)?|\d{2}x\d{2}|(us|uk|eu)\s?\d{1,2}(\.\d)?)$/i.test(p),
  );
  if (guess) return { source: "title", label: guess };

  return { source: "absent" };
}

// ---------------------------------------------------------------- per product

/**
 * Brands that size/resolver.ts actually maps (seven + the Jordan alias). Kept
 * local so ucp/ stays independent of size/ — keep in sync with BRAND_ALIASES /
 * the CSV over there.
 */
const MAPPED_BRANDS = new Set(["nike", "jordan", "adidas", "new balance", "converse", "asics", "birkenstock", "salomon"]);

/**
 * Brands we can *recognise* in a title or tag — a superset of MAPPED_BRANDS, so
 * coverage math can tell "unmapped brand" (Hoka) apart from "no brand found".
 */
const KNOWN_BRANDS = [
  "nike", "air jordan", "jordan", "adidas", "new balance", "converse", "asics", "birkenstock",
  "salomon", "puma", "reebok", "vans", "hoka", "on running", "saucony", "brooks", "mizuno",
  "veja", "norda", "merrell", "ugg", "crocs", "clarks", "dr martens", "timberland",
  "maison margiela", "margiela", "common projects", "autry", "diadora", "onitsuka tiger",
  "moon boot", "stepney workers club", "wales bonner",
];

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

function canonBrand(b: string): string {
  if (b === "air jordan") return "jordan";
  if (b === "margiela") return "maison margiela";
  if (b === "on running") return "on";
  return b;
}

type NumberingSystem = "EU" | "US/UK" | "alpha" | "mixed" | "none";
type Gender = "men" | "women" | "men+women" | "unisex" | "?";

interface ProductReport {
  title: string;
  brand: string;
  brandSource: "title" | "tag" | "none";
  brandMapped: boolean;
  gender: Gender;
  sizeOptionName: string | null;
  sizeLabels: string[];
  numericRange: [number, number] | null;
  numberingSystem: NumberingSystem;
  rangeNote: string | null;
  categories: string[];
}

function inferBrand(p: UcpProduct): { brand: string; source: "title" | "tag" | "none" } {
  const byLen = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  const title = norm(p.title);
  for (const b of byLen) if (title === b || title.startsWith(b + " ")) return { brand: canonBrand(b), source: "title" };

  const tags = new Set((p.tags ?? []).map(norm));
  for (const b of byLen) if (tags.has(b)) return { brand: canonBrand(b), source: "tag" };

  return { brand: "?", source: "none" };
}

function inferGender(p: UcpProduct): Gender {
  const tags = new Set((p.tags ?? []).map(norm));
  const m = tags.has("mens") || tags.has("men") || tags.has("m footwear");
  const w = tags.has("wmns") || tags.has("womens") || tags.has("women") || tags.has("w footwear");
  if (m && w) return "men+women";
  if (m) return "men";
  if (w) return "women";
  if (tags.has("unisex")) return "unisex";
  return "?";
}

const ALPHA_SIZE = /^(x*s|s|m|l|x*l|o\/s|one size|osfa)$/i;

/** Classify a Size run by its shape — the whole set, not any single label. */
function classifyRun(labels: string[]): {
  system: NumberingSystem;
  range: [number, number] | null;
  note: string | null;
} {
  if (labels.length === 0) return { system: "none", range: null, note: null };

  const nums = labels
    .map((l) => l.match(/^\s*(\d+(?:\.\d+)?)/))
    .map((m) => (m ? Number(m[1]) : null))
    .filter((n): n is number => n !== null);

  if (nums.length === 0) {
    const alpha = labels.some((l) => ALPHA_SIZE.test(l.trim()));
    return { system: alpha ? "alpha" : "none", range: null, note: null };
  }

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const eu = nums.filter((n) => n >= 33 && n <= 52).length;
  const usuk = nums.filter((n) => n >= 1 && n <= 20).length;

  let system: NumberingSystem;
  if (eu === nums.length) system = "EU";
  else if (usuk === nums.length) system = "US/UK";
  else system = "mixed";

  let note: string | null = null;
  if (system === "EU") {
    note = `${min}–${max} EU — resolve directly, no US/UK guess`;
  } else if (system === "mixed") {
    note = `${min}–${max} — two numbering systems in one option; split before resolving`;
  } else if (max <= 8) {
    note = `tops out at ${max} — women's US or men's UK, not men's US (those go past 12)`;
  } else if (min >= 6) {
    note = `${min}–${max} — men's US shape`;
  } else {
    note = `${min}–${max} — one numeric axis covering men's and women's; the number does not encode gender, the tags do`;
  }
  return { system, range: [min, max], note };
}

function sortLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((a, b) => {
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------- store report

interface StoreReport {
  domain: string;
  ok: boolean;
  error?: string;
  protocolVersion?: string;
  transport?: string;
  endpoint?: string;
  negotiated?: Record<string, string>;
  advertised?: Record<string, string[]>;
  warnings?: string[];
  products?: number;
  variants?: number;
  sizeSources?: Record<SizeSource, number>;
  optionNamesSeen?: Record<string, number>;
  sampleLabels?: string[];
  hasMetadata?: boolean;
  productDetail?: ProductReport[];
}

async function probeStore(domain: string, query: string): Promise<StoreReport> {
  let store: NegotiatedStore;
  try {
    store = await negotiateStore(domain, { allowRedirects: true });
  } catch (err) {
    return { domain, ok: false, error: (err as Error).message };
  }

  const advertised: Record<string, string[]> = {};
  for (const [name, entries] of Object.entries(store.raw.ucp.capabilities ?? {})) {
    advertised[name] = entries.map((e) => e.version);
  }

  const report: StoreReport = {
    domain,
    ok: true,
    protocolVersion: store.protocolVersion,
    transport: store.transport,
    endpoint: store.endpoint,
    negotiated: Object.fromEntries(
      Object.values(store.capabilities).map((c) => [c.name, c.version]),
    ),
    advertised,
    warnings: store.warnings,
  };

  if (!(CATALOG_SEARCH in store.capabilities)) return report;

  let products: UcpProduct[];
  try {
    const res = await searchCatalog(store, {
      query,
      context: { address_country: "CA", currency: "CAD", language: "en" },
      pagination: { limit: 20 },
    });
    products = res.products ?? [];
  } catch (err) {
    report.error = `search failed: ${(err as Error).message}`;
    return report;
  }

  const sizeSources: Record<SizeSource, number> = {
    "variant.options": 0,
    "product.options": 0,
    title: 0,
    absent: 0,
  };
  const optionNamesSeen: Record<string, number> = {};
  const sampleLabels = new Set<string>();
  const productDetail: ProductReport[] = [];
  let variants = 0;
  let hasMetadata = false;

  for (const product of products) {
    for (const o of product.options ?? []) {
      optionNamesSeen[o.name] = (optionNamesSeen[o.name] ?? 0) + 1;
    }
    if (product.metadata && Object.keys(product.metadata).length) hasMetadata = true;

    for (const variant of product.variants ?? []) {
      variants += 1;
      if (variant.metadata && Object.keys(variant.metadata).length) hasMetadata = true;
      const hit = resolveSize(product, variant);
      sizeSources[hit.source] += 1;
      if (hit.label && sampleLabels.size < 30) sampleLabels.add(hit.label);
    }

    const sizeOpt = (product.options ?? []).find((o) => SIZE_NAME.test(o.name.trim()));
    const sizeLabels = sizeOpt ? sortLabels(sizeOpt.values.map((v) => v.label.trim())) : [];
    const { brand, source } = inferBrand(product);
    const run = classifyRun(sizeLabels);
    productDetail.push({
      title: product.title,
      brand,
      brandSource: source,
      brandMapped: MAPPED_BRANDS.has(brand),
      gender: inferGender(product),
      sizeOptionName: sizeOpt?.name ?? null,
      sizeLabels,
      numericRange: run.range,
      numberingSystem: run.system,
      rangeNote: run.note,
      categories: (product.categories ?? []).map((c) => {
        const value = String(c.value ?? "").replace("gid://shopify/TaxonomyCategory/", "");
        const taxonomy = (c as Record<string, unknown>).taxonomy;
        return typeof taxonomy === "string" ? `${taxonomy}:${value}` : value;
      }),
    });
  }

  if (products[0]) {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      `${OUT_DIR}/${domain.replace(/[^\w.-]/g, "_")}.sample.json`,
      JSON.stringify(products[0], null, 2),
    );
  }

  return {
    ...report,
    products: products.length,
    variants,
    sizeSources,
    optionNamesSeen,
    sampleLabels: [...sampleLabels],
    hasMetadata,
    productDetail,
  };
}

function pct(n: number, total: number): string {
  return total === 0 ? "—" : `${Math.round((n / total) * 100)}%`;
}

function print(r: StoreReport): void {
  console.log(`\n${"─".repeat(64)}\n${r.domain}`);
  if (!r.ok) {
    console.log(`  FAILED: ${r.error}`);
    return;
  }

  console.log(`  protocol   ${r.protocolVersion}`);
  console.log(`  transport  ${r.transport} -> ${r.endpoint}`);
  console.log(`  advertised`);
  for (const [name, versions] of Object.entries(r.advertised ?? {})) {
    const chosen = r.negotiated?.[name];
    const mark = chosen ? `negotiated ${chosen}` : "NOT NEGOTIATED";
    console.log(`    ${name} [${versions.join(", ")}]  ${mark}`);
  }
  for (const w of r.warnings ?? []) console.log(`  ! ${w}`);
  if (r.error) console.log(`  ! ${r.error}`);

  if (r.variants == null) return;

  console.log(`\n  ${r.products} products, ${r.variants} variants`);
  console.log(`  size resolved from:`);
  for (const [source, count] of Object.entries(r.sizeSources ?? {})) {
    console.log(`    ${source.padEnd(16)} ${String(count).padStart(4)}  ${pct(count, r.variants)}`);
  }
  const names = Object.entries(r.optionNamesSeen ?? {}).sort((a, b) => b[1] - a[1]);
  console.log(`  option names: ${names.map(([n, c]) => `${n}(${c})`).join(", ") || "none"}`);
  console.log(`  size labels (flattened across all products — see per-product below):`);
  console.log(`    ${r.sampleLabels?.join(" | ") || "none"}`);
  if (r.hasMetadata) console.log(`  → merchant metadata present; read the sample JSON`);

  printProductDetail(r.productDetail ?? []);
}

function printProductDetail(products: ProductReport[]): void {
  if (products.length === 0) return;

  console.log(`\n  per product`);
  for (const p of products) {
    const tag = p.brand === "?" ? "brand?" : p.brandMapped ? "mapped" : "UNMAPPED";
    console.log(`    ${p.title}`);
    console.log(
      `      ${p.brand} (${p.brandSource}, ${tag}) · ${p.gender} · ${p.numberingSystem}` +
        `${p.categories.length ? ` · ${p.categories.join(", ")}` : ""}`,
    );
    console.log(`      ${p.sizeOptionName ?? "no size option"}: ${p.sizeLabels.join(" ") || "—"}`);
    if (p.rangeNote) console.log(`      ~ ${p.rangeNote}`);
  }

  // Grouped by inferred numbering system.
  const bySystem: Record<string, string[]> = {};
  for (const p of products) (bySystem[p.numberingSystem] ??= []).push(p.title);
  console.log(`\n  by numbering system`);
  for (const [sys, titles] of Object.entries(bySystem).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${sys.padEnd(7)} ${String(titles.length).padStart(2)}  ${titles.join("; ")}`);
  }

  // Brand coverage against the seven mapped brands.
  const byBrand: Record<string, number> = {};
  for (const p of products) byBrand[p.brand] = (byBrand[p.brand] ?? 0) + 1;
  const mapped = products.filter((p) => p.brandMapped).length;
  const unrecognised = byBrand["?"] ?? 0;
  const unmappedBrands = [...new Set(products.filter((p) => p.brand !== "?" && !p.brandMapped).map((p) => p.brand))];

  console.log(`\n  brand coverage — ${mapped}/${products.length} products are one of the seven mapped brands`);
  for (const [b, c] of Object.entries(byBrand).sort((a, b) => b[1] - a[1])) {
    const label = b === "?" ? "no brand detected" : MAPPED_BRANDS.has(b) ? "mapped" : "NOT mapped";
    console.log(`    ${b.padEnd(16)} ${String(c).padStart(2)}  ${label}`);
  }
  if (unmappedBrands.length) {
    console.log(`  ! ${unmappedBrands.join(", ")} present but unmapped — fit verdicts for these come back unmapped_brand`);
  }
  if (unrecognised) {
    console.log(`  ! ${unrecognised} product(s) with no brand detected from title or tags`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const qIndex = args.indexOf("--query");
  const query = qIndex >= 0 ? args[qIndex + 1] : "t-shirt";
  const domains = args.filter((a, i) => !a.startsWith("--") && i !== qIndex + 1);

  if (domains.length === 0) {
    console.error(
      "usage: tsx ucp/probe.ts <domain...> [--query 't-shirt']\n" +
        "  Pass the exact hostnames of the UCP stores you confirmed live.",
    );
    process.exit(1);
  }

  const reports: StoreReport[] = [];
  for (const domain of domains) {
    reports.push(await probeStore(domain, query));
  }
  reports.forEach(print);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/report.json`, JSON.stringify(reports, null, 2));

  const totalVariants = reports.reduce((n, r) => n + (r.variants ?? 0), 0);
  const trustworthy = reports.reduce(
    (n, r) => n + (r.sizeSources?.["variant.options"] ?? 0),
    0,
  );
  const allProducts = reports.flatMap((r) => r.productDetail ?? []);
  const mappedProducts = allProducts.filter((p) => p.brandMapped).length;

  console.log(`\n${"─".repeat(64)}`);
  console.log(
    `${pct(trustworthy, totalVariants)} of ${totalVariants} variants gave a clean ` +
      `variant.options size. The rest is the normalizer's job.`,
  );
  if (allProducts.length) {
    console.log(
      `${pct(mappedProducts, allProducts.length)} of ${allProducts.length} products are a mapped ` +
        `brand — the rest resolve as unmapped_brand for this query.`,
    );
  }
  console.log(`Raw samples + report.json in ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
