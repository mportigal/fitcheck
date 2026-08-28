/**
 * size/demo.ts — the one-screen argument for resolving on foot length.
 *
 *   npx tsx size/demo.ts
 *
 * 1. Same label, different feet: a men's US 9 is a different foot length in
 *    every brand.
 * 2. The resolver's four outcomes: exact, interpolated, extrapolated, unknown.
 * 3. Reverse: a measured foot length -> the size to buy per brand.
 */

import { loadDefaultSizeTable, parseSizeLabel, type Gender, type SizeSystem } from "./resolver.js";

const table = loadDefaultSizeTable();

function rule(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

// 1 -------------------------------------------------------------------------
rule("Men's US 9 — same label, different foot length");
const us9 = table
  .brandKeys()
  .map((b) => ({ brand: table.brandLabel(b), r: table.resolve({ brand: b, gender: "men", system: "us", value: 9 }) }))
  .filter((x) => x.r.footLengthMm !== undefined)
  .sort((a, b) => a.r.footLengthMm! - b.r.footLengthMm!);

for (const { brand, r } of us9) {
  console.log(`  ${brand.padEnd(14)} ${r.footLengthMm} mm   (${r.status})`);
}
const spread = us9[us9.length - 1].r.footLengthMm! - us9[0].r.footLengthMm!;
console.log(`  spread: ${spread} mm across ${us9.length} brands — that is the whole point`);

// 2 -------------------------------------------------------------------------
rule("Resolver outcomes");
const cases: Array<{ label: string; q: { brand: string; gender: Gender; system: SizeSystem; value: number } }> = [
  { label: "Nike men US 9 (a real row)", q: { brand: "Nike", gender: "men", system: "us", value: 9 } },
  { label: "Nike men US 11 (a gap we map)", q: { brand: "Nike", gender: "men", system: "us", value: 11 } },
  { label: "Jordan men US 9 (alias -> Nike)", q: { brand: "Jordan", gender: "men", system: "us", value: 9 } },
  { label: "Birkenstock men US 9 (non-native label)", q: { brand: "Birkenstock", gender: "men", system: "us", value: 9 } },
  { label: "Birkenstock men EU 42 (native)", q: { brand: "Birkenstock", gender: "men", system: "eu", value: 42 } },
  { label: "Birkenstock men US 20 (past the range)", q: { brand: "Birkenstock", gender: "men", system: "us", value: 20 } },
  { label: "New Balance women US 8 (men's-only brand)", q: { brand: "New Balance", gender: "women", system: "us", value: 8 } },
  { label: "Reebok men US 9 (brand we don't map)", q: { brand: "Reebok", gender: "men", system: "us", value: 9 } },
];

for (const { label, q } of cases) {
  const r = table.resolve(q);
  const head =
    r.status === "unknown"
      ? `unknown — ${r.reason}`
      : `${r.footLengthMm} mm · ${r.status} · confidence ${r.confidence}` +
        (r.between ? ` · between ${r.between[0]} and ${r.between[1]}` : "");
  console.log(`  ${label}`);
  console.log(`    -> ${head}`);
  for (const w of r.warnings) console.log(`       note: ${w}`);
}

// 3 -------------------------------------------------------------------------
rule("Reverse — foot length 266 mm, what do I buy?");
for (const b of ["Nike", "Adidas", "ASICS", "Converse"]) {
  const r = table.recommend({ brand: b, gender: "men", footLengthMm: 266 });
  const s = r.status === "unknown" ? `unknown — ${r.reason}` : `${r.label}  (US ${r.us} / UK ${r.uk} / EU ${r.eu})`;
  console.log(`  ${b.padEnd(10)} ${s}${r.offersWidthGrades ? "  [width grades available]" : ""}`);
}

// 4 -------------------------------------------------------------------------
rule("Freeform label parsing");
for (const raw of ["9", "US 9", "UK 8", "42", "42.5", "EU 42 2/3", "M 10", "XL"]) {
  const p = parseSizeLabel(raw);
  console.log(`  ${JSON.stringify(raw).padEnd(12)} -> ${p ? `${p.system} ${p.value}${p.ambiguous ? " (guessed)" : ""}` : "no number — not a size"}`);
}
