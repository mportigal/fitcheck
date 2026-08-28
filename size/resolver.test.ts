/**
 * size/resolver.test.ts — run with `npm test` (node:test via tsx).
 *
 * Covers the two bugs found in review:
 *   1. estimateFootLength averaged disagreeing statements and reported "ok".
 *   2. recommend rounded to nearest, returning sizes shorter than the foot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultSizeTable, estimateFootLength, type FitStatement } from "./resolver.js";

const table = loadDefaultSizeTable();
const men = (brand: string, value: number): FitStatement => ({ brand, gender: "men", system: "us", value });

// ------------------------------------------------------------- bug 1: intersect

test("estimateFootLength: statements within a half-size agree and give a bestMm", () => {
  // Nike US 9 = 263 mm, Converse US 9 = 265 mm -> 2 mm apart.
  const est = estimateFootLength(table, [men("Nike", 9), men("Converse", 9)]);
  assert.equal(est.status, "ok");
  assert.equal(est.low, 263);
  assert.equal(est.high, 265);
  assert.equal(est.spreadMm, 2);
  assert.equal(est.bestMm, 264);
});

test("estimateFootLength: statements a full size apart are a CONFLICT, not an average", () => {
  // Nike US 9 = 263 mm, Converse US 9.5 = 270 mm (interpolated) -> 7 mm apart.
  const est = estimateFootLength(table, [men("Nike", 9), men("Converse", 9.5)]);
  assert.equal(est.status, "conflict");
  assert.equal(est.spreadMm, 7);
  assert.equal(est.bestMm, undefined, "a conflict must not be resolved by averaging");
  assert.equal(est.longerStatement?.brand, "Converse");
  assert.equal(est.shorterStatement?.brand, "Nike");
  assert.ok(est.warnings.some((w) => /which fits better|ask/i.test(w)));
});

test("estimateFootLength: 266.5 is never produced from 263 + 270", () => {
  const est = estimateFootLength(table, [men("Nike", 9), men("Converse", 9.5)]);
  assert.notEqual(est.bestMm, 266.5);
});

test("estimateFootLength: no resolvable statements -> unresolved", () => {
  const est = estimateFootLength(table, [men("Reebok", 9)]);
  assert.equal(est.status, "unresolved");
});

// ------------------------------------------------------------- bug 2: round up

test("recommend: never returns a size shorter than the foot when a longer one exists", () => {
  const brands = ["Nike", "Adidas", "ASICS", "Converse", "New Balance", "Birkenstock"];
  for (const brand of brands) {
    for (let footLengthMm = 240; footLengthMm <= 300; footLengthMm += 0.5) {
      const r = table.recommend({ brand, gender: "men", footLengthMm });
      if (r.status === "unknown" || r.status === "beyond_range") continue;
      assert.ok(
        r.sizeLengthMm! >= footLengthMm - 0.5,
        `${brand} @ ${footLengthMm} mm -> US ${r.us} (${r.sizeLengthMm} mm) is shorter than the foot`,
      );
    }
  }
});

test("recommend: the review's failing cases now round up", () => {
  const bk = table.recommend({ brand: "Birkenstock", gender: "men", footLengthMm: 266.5 });
  assert.equal(bk.status, "rounded_up");
  assert.equal(bk.us, 9);
  assert.equal(bk.eu, 42);
  assert.equal(bk.sizeLengthMm, 270);

  const ad = table.recommend({ brand: "Adidas", gender: "men", footLengthMm: 266.5 });
  assert.equal(ad.us, 9);
  assert.equal(ad.sizeLengthMm, 270);
});

test("recommend: ASICS 266.5 was already right and stays right", () => {
  const as = table.recommend({ brand: "ASICS", gender: "men", footLengthMm: 266.5 });
  assert.equal(as.us, 9);
  assert.equal(as.sizeLengthMm, 268);
});

test("recommend: a row that equals the foot is exact, zero headroom", () => {
  const r = table.recommend({ brand: "Nike", gender: "men", footLengthMm: 263 });
  assert.equal(r.status, "exact");
  assert.equal(r.us, 9);
  assert.equal(r.headroomMm, 0);
});

test("recommend: foot longer than every mapped size -> beyond_range, low confidence", () => {
  const r = table.recommend({ brand: "Converse", gender: "men", footLengthMm: 320 });
  assert.equal(r.status, "beyond_range");
  assert.equal(r.confidence, "low");
  assert.equal(r.us, 12); // Converse men's largest row
});

test("recommend: unmapped gender -> unknown, no fabricated size", () => {
  const r = table.recommend({ brand: "New Balance", gender: "women", footLengthMm: 250 });
  assert.equal(r.status, "unknown");
  assert.equal(r.us, undefined);
});

// ------------------------------------------------------------- resolve() sanity

test("resolve: men's US 9 spans 263-270 mm across the six brands", () => {
  const lengths = table
    .brandKeys()
    .map((b) => table.resolve({ brand: b, gender: "men", system: "us", value: 9 }).footLengthMm)
    .filter((mm): mm is number => mm !== undefined);
  assert.equal(Math.min(...lengths), 263);
  assert.equal(Math.max(...lengths), 270);
});

test("resolve: an in-range gap interpolates, never returns unknown", () => {
  const r = table.resolve({ brand: "Nike", gender: "men", system: "us", value: 11 });
  assert.equal(r.status, "interpolated");
  assert.deepEqual(r.between, [10, 11.5]);
});

test("resolve: Jordan aliases to Nike", () => {
  const j = table.resolve({ brand: "Jordan", gender: "men", system: "us", value: 9 });
  assert.equal(j.footLengthMm, 263);
  assert.equal(j.resolvedBrand, "nike");
});

test("resolve: Birkenstock US label is low confidence, EU label is high", () => {
  const us = table.resolve({ brand: "Birkenstock", gender: "men", system: "us", value: 8 });
  const eu = table.resolve({ brand: "Birkenstock", gender: "men", system: "eu", value: 41 });
  assert.equal(us.confidence, "low");
  assert.equal(eu.confidence, "high");
  assert.equal(us.footLengthMm, eu.footLengthMm);
});
