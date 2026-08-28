/**
 * size/demo.ts — the one-screen argument for resolving on foot length.
 *
 *   npx tsx size/demo.ts
 *
 * 1. Same label, different feet: a men's US 9 is a different foot length in
 *    every brand.
 * 2. The resolver's four outcomes: exact, interpolated, extrapolated, unknown.
 * 3. A worked user path: two shoes that fit -> foot length -> what to buy,
 *    rounding up. Then the same path with two shoes that DON'T agree, where
 *    the profile has to ask the user. Exercises interpolation, round-up
 *    recommendation, EU steering, and multi-statement intersection.
 * 4. Freeform label parsing.
 */

import {
  loadDefaultSizeTable,
  parseSizeLabel,
  estimateFootLength,
  type FitStatement,
  type Gender,
  type SizeSystem,
} from "./resolver.js";

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
rule('Worked path — "Nike 9 fits, Converse 9 fits" -> what do I buy?');

const profile: FitStatement[] = [
  { brand: "Nike", gender: "men", system: "us", value: 9, verdict: "fits" },
  { brand: "Converse", gender: "men", system: "us", value: 9, verdict: "fits" },
];

const est = estimateFootLength(table, profile);
console.log("  the shoes that fit, resolved to length:");
for (const r of est.resolved) {
  const s = r.statement;
  console.log(`    ${s.brand} ${s.system.toUpperCase()} ${s.value} fits  ->  ${r.footLengthMm} mm  (${r.status})`);
}
console.log(
  `  agree within ${est.spreadMm} mm -> foot length ${est.low}–${est.high} mm, ` +
    `best estimate ${est.bestMm} mm  [${est.status}]`,
);
for (const w of est.warnings) console.log(`    note: ${w}`);

console.log("\n  buy, by brand — round UP, never shorter than the foot (Birkenstock in native EU):");
for (const b of ["Birkenstock", "ASICS", "New Balance"]) {
  const rec = table.recommend({ brand: b, gender: "men", footLengthMm: est.bestMm! });
  if (rec.status === "unknown") {
    console.log(`    ${b.padEnd(12)} unknown — ${rec.reason}`);
    continue;
  }
  const native = b === "Birkenstock" ? `EU ${rec.eu}` : `US ${rec.us}`;
  const sign = rec.headroomMm! >= 0 ? "+" : "";
  console.log(
    `    ${b.padEnd(12)} ${native.padEnd(6)} (US ${rec.us} / UK ${rec.uk} / EU ${rec.eu})  ` +
      `${rec.sizeLengthMm} mm, ${sign}${rec.headroomMm} mm headroom  — ${rec.label}` +
      `${rec.offersWidthGrades ? "  [width grades]" : ""}`,
  );
}

// 3b ------------------------------------------------------------------------
rule('Conflict — "Nike 9 fits, Converse 9.5 fits" (the profile has to ask)');

const conflicting: FitStatement[] = [
  { brand: "Nike", gender: "men", system: "us", value: 9, verdict: "fits" },
  { brand: "Converse", gender: "men", system: "us", value: 9.5, verdict: "fits" },
];
const c = estimateFootLength(table, conflicting);
for (const r of c.resolved) {
  const s = r.statement;
  console.log(`  ${s.brand} ${s.system.toUpperCase()} ${s.value} fits  ->  ${r.footLengthMm} mm  (${r.status})`);
}
console.log(`  -> [${c.status}] spread ${c.spreadMm} mm, no best estimate; low ${c.low} / high ${c.high} mm`);
for (const w of c.warnings) console.log(`     ${w}`);
if (c.status === "conflict") {
  const lo = c.shorterStatement!;
  const hi = c.longerStatement!;
  console.log(
    `  UI asks: "Your ${hi.brand} ${hi.system.toUpperCase()} ${hi.value} and ${lo.brand} ` +
      `${lo.system.toUpperCase()} ${lo.value} don't quite agree — which fits better?"`,
  );
}

// 3c ------------------------------------------------------------------------
rule("Why Birkenstock is read in EU — same size, two labels");
const bkUs = table.resolve({ brand: "Birkenstock", gender: "men", system: "us", value: 8 });
const bkEu = table.resolve({ brand: "Birkenstock", gender: "men", system: "eu", value: 41 });
console.log(`  by US 8  -> ${bkUs.footLengthMm} mm, confidence ${bkUs.confidence}`);
for (const w of bkUs.warnings) console.log(`             ${w}`);
console.log(`  by EU 41 -> ${bkEu.footLengthMm} mm, confidence ${bkEu.confidence}`);

// 4 -------------------------------------------------------------------------
rule("Freeform label parsing");
for (const raw of ["9", "US 9", "UK 8", "42", "42.5", "EU 42 2/3", "M 10", "XL"]) {
  const p = parseSizeLabel(raw);
  console.log(`  ${JSON.stringify(raw).padEnd(12)} -> ${p ? `${p.system} ${p.value}${p.ambiguous ? " (guessed)" : ""}` : "no number — not a size"}`);
}
