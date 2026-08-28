/**
 * size/fit.test.ts — run with `npm test`.
 *
 * The verdict tree for a per-product fit check, plus numbering-system inference.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultSizeTable } from "./resolver.js";
import { checkFit, inferNumberingSystem } from "./fit.js";

const table = loadDefaultSizeTable();

const US_FULL = "3 3.5 4 4.5 5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13".split(" ");
const US_WHOLE = "6 7 8 9 10 11 12".split(" ");
const EU_RUN = "38 39 40 41 42 43 44 45 46".split(" ");

test("inferNumberingSystem reads the run's shape", () => {
  assert.equal(inferNumberingSystem(US_FULL), "us/uk");
  assert.equal(inferNumberingSystem(EU_RUN), "eu");
  assert.equal(inferNumberingSystem(["34", "9"]), "mixed");
  assert.equal(inferNumberingSystem(["S", "M", "L"]), "alpha");
  assert.equal(inferNumberingSystem([]), "none");
});

test("fits: target size listed and in stock", () => {
  const v = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 263, runLabels: US_FULL, availability: { 9: { exists: true, available: true } } },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "US 9");
  assert.equal(v.sizeLengthMm, 263);
  assert.equal(v.headroomMm, 0);
});

test("out_of_stock (available:false) is distinct from no_size (exists:false)", () => {
  const oos = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 263, runLabels: US_FULL, availability: { 9: { exists: true, available: false } } },
    table,
  );
  assert.equal(oos.verdict, "out_of_stock");

  const notMade = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 263, runLabels: US_FULL, availability: { 9: { exists: false, available: false } } },
    table,
  );
  assert.equal(notMade.verdict, "no_size");
  assert.match(notMade.sentence, /doesn't make it/);
});

test("no_size: foot beyond the brand's mapped range", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 340, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "no_size");
  assert.match(v.sentence, /longer than/);
});

test("no_size: target above what this shoe offers", () => {
  const shortRun = "6 7 8 9".split(" ");
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 283, runLabels: shortRun }, table);
  assert.equal(v.verdict, "no_size");
  assert.match(v.sentence, /this shoe runs/);
});

test("between_sizes: foot falls between two listed sizes, size up", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 265, runLabels: US_WHOLE }, table);
  assert.equal(v.verdict, "between_sizes");
  assert.equal(v.recommendedLabel, "US 10");
  assert.ok((v.headroomMm ?? 0) > 0);
});

test("size_down: the size up is gone, steer to the snug one below", () => {
  const v = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 265, runLabels: US_WHOLE, availability: { 10: { exists: true, available: false } } },
    table,
  );
  assert.equal(v.verdict, "size_down");
  assert.equal(v.recommendedLabel, "US 9");
});

test("EU run resolves in EU directly", () => {
  const v = checkFit(
    { brand: "Birkenstock", gender: "men", footLengthMm: 270, runLabels: EU_RUN, availability: { 42: { exists: true, available: true } } },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "EU 42");
});

test("unmapped_brand: no size mapping", () => {
  const v = checkFit({ brand: "Reebok", gender: "men", footLengthMm: 263, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "unmapped_brand");
});

test("unknown: no foot length yet", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: null, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "unknown");
});

test("unknown: alpha run is not a shoe scale we read", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 263, runLabels: ["S", "M", "L"] }, table);
  assert.equal(v.verdict, "unknown");
});

test("gender comes from the input, not the catalog: women's-only-gap brand", () => {
  // New Balance has no women's rows in the sample.
  const v = checkFit({ brand: "New Balance", gender: "women", footLengthMm: 250, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "unknown");
  assert.match(v.sentence.toLowerCase(), /women/);
});

test("labels-only (no availability) still returns fits when the size is listed", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 263, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "fits");
});
