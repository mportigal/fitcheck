/**
 * size/fit.test.ts — run with `npm test`.
 *
 * The verdict tree for a per-product fit check: numbering-system inference, the
 * toe-allowance target, and product-gender detection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultSizeTable } from "./resolver.js";
import { checkFit, detectTitleGender, inferNumberingSystem, TOE_ALLOWANCE_MM } from "./fit.js";

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

// ---- toe allowance -------------------------------------------------------

test("recommendation targets foot + toe allowance, not the bare length", () => {
  // Salomon men US 9 = 264 mm — the exact length of the foot, i.e. +0 mm room.
  // The verdict must move to a size with real toe room.
  const v = checkFit(
    {
      brand: "Salomon",
      gender: "men",
      footLengthMm: 264,
      runLabels: US_FULL,
      title: "Salomon XT-6 ADV - Black / Phantom",
    },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "US 10"); // 273 mm
  assert.equal(v.sizeLengthMm, 273);
  assert.equal(v.headroomMm, 9);
  assert.ok((v.headroomMm ?? 0) >= TOE_ALLOWANCE_MM - 3, "within a grid step of the allowance");
});

test("fits: toe allowance lands exactly on a listed size", () => {
  // Nike men US 9 = 263 mm; a 253 mm foot -> goal 263 -> US 9, +10 room.
  const v = checkFit(
    {
      brand: "Nike",
      gender: "men",
      footLengthMm: 253,
      runLabels: US_FULL,
      availability: { 9: { exists: true, available: true } },
    },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "US 9");
  assert.equal(v.sizeLengthMm, 263);
  assert.equal(v.headroomMm, TOE_ALLOWANCE_MM);
});

// ---- availability ------------------------------------------------------

test("out_of_stock (available:false) is distinct from no_size (exists:false)", () => {
  const base = { brand: "Nike", gender: "men" as const, footLengthMm: 253, runLabels: US_FULL };
  const oos = checkFit({ ...base, availability: { 9: { exists: true, available: false } } }, table);
  assert.equal(oos.verdict, "out_of_stock");

  const notMade = checkFit({ ...base, availability: { 9: { exists: false, available: false } } }, table);
  assert.equal(notMade.verdict, "no_size");
  assert.match(notMade.sentence, /doesn't make it/);
});

// ---- no_size / out-of-range ------------------------------------------

test("no_size: foot beyond the brand's mapped range", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 340, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "no_size");
  assert.match(v.sentence, /longer than/);
});

test("no_size: target above what this shoe offers", () => {
  const v = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 283, runLabels: "6 7 8 9".split(" ") },
    table,
  );
  assert.equal(v.verdict, "no_size");
  assert.match(v.sentence, /this shoe runs/);
});

// ---- between / neighbour steering ----------------------------------

test("between_sizes: target half-size not in a whole-size run -> size up", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 258, runLabels: US_WHOLE }, table);
  assert.equal(v.verdict, "between_sizes");
  assert.equal(v.recommendedLabel, "US 10");
  assert.ok((v.headroomMm ?? 0) > 0);
});

test("size_down: the size up is gone, steer to the snug one below", () => {
  const v = checkFit(
    {
      brand: "Nike",
      gender: "men",
      footLengthMm: 258,
      runLabels: US_WHOLE,
      availability: { 10: { exists: true, available: false } },
    },
    table,
  );
  assert.equal(v.verdict, "size_down");
  assert.equal(v.recommendedLabel, "US 9");
});

test("EU run resolves in EU directly", () => {
  const v = checkFit(
    {
      brand: "Birkenstock",
      gender: "men",
      footLengthMm: 260,
      runLabels: EU_RUN,
      availability: { 42: { exists: true, available: true } },
    },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "EU 42");
  assert.equal(v.headroomMm, TOE_ALLOWANCE_MM);
});

// ---- unmapped / unknown ---------------------------------------------

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

test("unknown: brand mapped but not for this gender (New Balance women's-only gap)", () => {
  const v = checkFit({ brand: "New Balance", gender: "women", footLengthMm: 250, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "unknown");
  assert.match(v.sentence.toLowerCase(), /women/);
});

test("labels-only (no availability) still returns fits when the size is listed", () => {
  const v = checkFit({ brand: "Nike", gender: "men", footLengthMm: 253, runLabels: US_FULL }, table);
  assert.equal(v.verdict, "fits");
});

// ---- product gender detection -------------------------------------

test("detectTitleGender reads WMNS / Women's / standalone W", () => {
  assert.equal(detectTitleGender("adidas WMNS Samba Jane  - White"), "women");
  assert.equal(detectTitleGender("adidas W Samba"), "women");
  assert.equal(detectTitleGender("Women's Nike Pegasus"), "women");
  assert.equal(detectTitleGender("Nike Air Force 1 '07 - White"), null);
  assert.equal(detectTitleGender("New Balance 990v6 - Grey"), null);
});

test("gender conflict: women's product + men's profile -> unknown, and it says so", () => {
  const v = checkFit(
    {
      brand: "Adidas",
      gender: "men",
      footLengthMm: 253,
      runLabels: US_FULL,
      title: "adidas WMNS Samba Jane  - White / Alumina / Core Black",
    },
    table,
  );
  assert.equal(v.verdict, "unknown");
  assert.match(v.sentence, /women's shoe/);
  assert.match(v.sentence, /profile/);
});

test("no title gender signal: resolves against the profile gender as before", () => {
  const v = checkFit(
    { brand: "Nike", gender: "men", footLengthMm: 253, runLabels: US_FULL, title: "Nike Air Force 1 '07 - White" },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "US 9");
});

test("gender unset in profile: falls back to the product's detected gender", () => {
  // Adidas women's US 9 = 255 mm; men's curve for a 245 mm foot would land elsewhere.
  const v = checkFit(
    { brand: "Adidas", gender: null, footLengthMm: 245, runLabels: US_FULL, title: "adidas WMNS Samba Jane" },
    table,
  );
  assert.equal(v.verdict, "fits");
  assert.equal(v.recommendedLabel, "US 9");
});
