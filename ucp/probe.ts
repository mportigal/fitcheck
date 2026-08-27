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
  console.log(`  size labels:  ${r.sampleLabels?.join(" | ") || "none"}`);
  if (r.hasMetadata) console.log(`  → merchant metadata present; read the sample JSON`);
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
  console.log(`\n${"─".repeat(64)}`);
  console.log(
    `${pct(trustworthy, totalVariants)} of ${totalVariants} variants gave a clean ` +
      `variant.options size. The rest is the normalizer's job.`,
  );
  console.log(`Raw samples + report.json in ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
