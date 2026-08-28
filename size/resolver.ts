/**
 * size/resolver.ts — brand size label  <->  foot length.
 *
 * The catalog hands us a freeform size label ("9", "US 9", "42") stamped by a
 * brand that sizes its shoes differently from every other brand. This module
 * turns that label into a foot length in millimetres — the only thing that
 * actually fits a foot — and back again.
 *
 * Reference data: size/sizely-shoe-sample.csv, real measured rows from Sizely,
 * not a smoothed curve. One row per (brand, gender, size) with US / UK / EU
 * labels side by side and the foot length they all resolve to.
 *
 * Behaviour, per Sizely's guidance (2026-08-28):
 *
 *  - Exact row               -> that foot length.
 *  - Gap inside a mapped brand (e.g. Nike men's US 11, not a row) -> linear
 *    interpolation between the two bracketing rows, reported as
 *    `between: [10, 11.5]`. Never "unknown".
 *  - Outside a mapped brand's range -> extrapolation from the nearest two rows,
 *    confidence "low". Still not "unknown".
 *  - Brand we have no rows for -> status "unknown". This is the ONLY unknown.
 *  - Brand we map but not for that gender (New Balance and Converse are men's
 *    only in this slice) -> status "unknown", with a gender-specific reason.
 *  - Jordan is aliased to Nike (Jordan follows Nike sizing; Kith carries a lot
 *    of Jordans).
 *  - Birkenstock resolves through EU, its native system. A US/UK lookup still
 *    returns a length but is flagged confidence "low" — even Birkenstock's own
 *    US labels are internally inconsistent.
 *
 * Width grades (New Balance, Nike, ASICS) are a girth dimension, surfaced via
 * `offersWidthGrades` but never a change in length.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Gender = "men" | "women";
export type SizeSystem = "us" | "uk" | "eu";
export type Confidence = "high" | "low";

export interface SizeRow {
  /** Canonical brand key, lower-cased. */
  brand: string;
  /** Original display casing, e.g. "New Balance". */
  brandLabel: string;
  gender: Gender;
  us: number;
  uk: number;
  eu: number;
  footLengthMm: number;
  offersWidthGrades: boolean;
}

export interface SizeQuery {
  brand: string;
  gender: Gender;
  system: SizeSystem;
  value: number;
}

export type ResolveStatus = "exact" | "interpolated" | "extrapolated" | "unknown";

export interface ResolveResult {
  status: ResolveStatus;
  /** Present unless status === "unknown". */
  footLengthMm?: number;
  /** For interpolated / extrapolated: the two known sizes (in `system`) used. */
  between?: [number, number];
  /** Canonical brand actually used, after alias resolution. */
  resolvedBrand?: string;
  confidence: Confidence;
  warnings: string[];
  /** Present only when status === "unknown". */
  reason?: string;
}

export interface RecommendQuery {
  brand: string;
  gender: Gender;
  footLengthMm: number;
  /** A row within this many mm counts as an exact recommendation. Default 2. */
  toleranceMm?: number;
}

export interface RecommendResult {
  status: ResolveStatus;
  /** Recommended size in each system, when resolvable. */
  us?: number;
  uk?: number;
  eu?: number;
  /** Human string, e.g. "US 9" or "between US 8 and US 9 — size up to US 9". */
  label?: string;
  offersWidthGrades?: boolean;
  resolvedBrand?: string;
  confidence: Confidence;
  warnings: string[];
  reason?: string;
}

// ------------------------------------------------------------- brand registry
// Tribal knowledge from Sizely's 2026-08-28 note. Kept as data, not scattered
// through the resolver.

/** Brands that size identically to another brand in the table. */
const BRAND_ALIASES: Record<string, string> = {
  jordan: "nike",
  "air jordan": "nike",
  "jordan brand": "nike",
};

/** Brands whose printed US/UK labels are not trustworthy; resolve via this system. */
const NATIVE_SYSTEM: Partial<Record<string, SizeSystem>> = {
  birkenstock: "eu",
};

export function canonicalBrand(raw: string): { key: string; aliased: boolean } {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const target = BRAND_ALIASES[norm];
  return target ? { key: target, aliased: true } : { key: norm, aliased: false };
}

// --------------------------------------------------------------------- loader

const EXPECTED_HEADER =
  "brand,gender,us_size,uk_size,eu_size,foot_length_cm,foot_length_mm,offers_width_grades";

export function loadSizeTable(csvText: string): SizeTable {
  // Skip blank lines and `#` comments (the file carries a source-credit header).
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  const header = lines.shift();
  if (header?.trim() !== EXPECTED_HEADER) {
    throw new Error(`size CSV: unexpected header\n  got:  ${header}\n  want: ${EXPECTED_HEADER}`);
  }
  const rows: SizeRow[] = lines.map((line, i) => {
    const c = line.split(",");
    if (c.length < 8) {
      throw new Error(`size CSV row ${i + 2}: expected 8 columns, got ${c.length}`);
    }
    const [brand, gender, us, uk, eu, , mm, width] = c;
    if (gender !== "men" && gender !== "women") {
      throw new Error(`size CSV row ${i + 2}: bad gender "${gender}"`);
    }
    const row: SizeRow = {
      brand: brand.trim().toLowerCase(),
      brandLabel: brand.trim(),
      gender,
      us: Number(us),
      uk: Number(uk),
      eu: Number(eu),
      footLengthMm: Number(mm),
      offersWidthGrades: width.trim().toLowerCase() === "yes",
    };
    for (const [k, v] of [
      ["us", row.us],
      ["uk", row.uk],
      ["eu", row.eu],
      ["foot_length_mm", row.footLengthMm],
    ] as const) {
      if (!Number.isFinite(v)) throw new Error(`size CSV row ${i + 2}: non-numeric ${k} "${v}"`);
    }
    return row;
  });
  return new SizeTable(rows);
}

/** Path to the CSV that ships with this module. */
export const DEFAULT_CSV_PATH = fileURLToPath(new URL("./sizely-shoe-sample.csv", import.meta.url));

export function loadDefaultSizeTable(): SizeTable {
  return loadSizeTable(readFileSync(DEFAULT_CSV_PATH, "utf8"));
}

// ---------------------------------------------------------------------- table

const KEY = (brand: string, gender: Gender) => `${brand}/${gender}`;
const lerp = (x0: number, y0: number, x1: number, y1: number, x: number) =>
  y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export class SizeTable {
  private readonly byBrandGender = new Map<string, SizeRow[]>();
  private readonly brands = new Set<string>();
  private readonly labels = new Map<string, string>();

  constructor(readonly rows: readonly SizeRow[]) {
    for (const r of rows) {
      this.brands.add(r.brand);
      this.labels.set(r.brand, r.brandLabel);
      const arr = this.byBrandGender.get(KEY(r.brand, r.gender)) ?? [];
      arr.push(r);
      this.byBrandGender.set(KEY(r.brand, r.gender), arr);
    }
    for (const arr of this.byBrandGender.values()) arr.sort((a, b) => a.us - b.us);
  }

  /** Canonical brand names present in the table. */
  brandKeys(): string[] {
    return [...this.brands].sort();
  }

  brandLabel(brandKey: string): string {
    return this.labels.get(brandKey) ?? brandKey;
  }

  /** Rows for a brand/gender, sorted by US size. Empty if unmapped. Alias-aware. */
  slice(brand: string, gender: Gender): SizeRow[] {
    return this.byBrandGender.get(KEY(canonicalBrand(brand).key, gender)) ?? [];
  }

  offersWidthGrades(brand: string): boolean {
    const key = canonicalBrand(brand).key;
    return this.rows.some((r) => r.brand === key && r.offersWidthGrades);
  }

  /** A size label -> foot length in mm. */
  resolve(q: SizeQuery): ResolveResult {
    const warnings: string[] = [];
    const { key: brand, aliased } = canonicalBrand(q.brand);
    if (aliased) warnings.push(`brand "${q.brand.trim()}" follows ${this.brandLabel(brand)} sizing`);

    if (!this.brands.has(brand)) {
      return {
        status: "unknown",
        confidence: "low",
        warnings,
        reason: `no size mapping for brand "${q.brand.trim()}"`,
      };
    }

    const rows = this.byBrandGender.get(KEY(brand, q.gender));
    if (!rows || rows.length === 0) {
      const other: Gender = q.gender === "men" ? "women" : "men";
      const hasOther = this.byBrandGender.has(KEY(brand, other));
      return {
        status: "unknown",
        confidence: "low",
        warnings,
        resolvedBrand: brand,
        reason: hasOther
          ? `${this.brandLabel(brand)} is ${other}'s-only in this dataset — no ${q.gender}'s rows`
          : `no ${q.gender}'s size mapping for ${this.brandLabel(brand)}`,
      };
    }

    // Native-system brands (Birkenstock): a non-native lookup still resolves,
    // but the label itself is not to be trusted.
    let confidence: Confidence = "high";
    const native = NATIVE_SYSTEM[brand];
    if (native && native !== q.system) {
      confidence = "low";
      warnings.push(
        `${this.brandLabel(brand)} sizes natively in ${native.toUpperCase()}; a ` +
          `${q.system.toUpperCase()} label is unreliable — prefer the ${native.toUpperCase()} ` +
          `label when the product exposes it`,
      );
    }

    const axis = (r: SizeRow) => r[q.system];
    const sorted = [...rows].sort((a, b) => axis(a) - axis(b));

    const exact = sorted.find((r) => axis(r) === q.value);
    if (exact) {
      return {
        status: "exact",
        footLengthMm: exact.footLengthMm,
        resolvedBrand: brand,
        confidence,
        warnings,
      };
    }

    const lo0 = sorted[0];
    const hi0 = sorted[sorted.length - 1];

    // In-range gap -> interpolate between the bracketing rows.
    if (q.value > axis(lo0) && q.value < axis(hi0)) {
      let lo = lo0;
      let hi = hi0;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (axis(sorted[i]) < q.value && axis(sorted[i + 1]) > q.value) {
          lo = sorted[i];
          hi = sorted[i + 1];
          break;
        }
      }
      return {
        status: "interpolated",
        footLengthMm: round1(lerp(axis(lo), lo.footLengthMm, axis(hi), hi.footLengthMm, q.value)),
        between: [axis(lo), axis(hi)],
        resolvedBrand: brand,
        confidence,
        warnings,
      };
    }

    // Out of range -> extrapolate from the nearest two rows. Always low confidence.
    const [a, b] =
      q.value <= axis(lo0)
        ? [sorted[0], sorted[1]]
        : [sorted[sorted.length - 2], sorted[sorted.length - 1]];
    warnings.push(
      `${q.system.toUpperCase()} ${q.value} is outside ${this.brandLabel(brand)} ${q.gender}'s ` +
        `mapped range (${axis(lo0)}–${axis(hi0)}); extrapolated`,
    );
    return {
      status: "extrapolated",
      footLengthMm: round1(lerp(axis(a), a.footLengthMm, axis(b), b.footLengthMm, q.value)),
      between: [axis(a), axis(b)],
      resolvedBrand: brand,
      confidence: "low",
      warnings,
    };
  }

  /** A foot length in mm -> the size to buy in this brand. Rounds up on a gap. */
  recommend(q: RecommendQuery): RecommendResult {
    const tol = q.toleranceMm ?? 2;
    const warnings: string[] = [];
    const { key: brand, aliased } = canonicalBrand(q.brand);
    if (aliased) warnings.push(`brand "${q.brand.trim()}" follows ${this.brandLabel(brand)} sizing`);

    if (!this.brands.has(brand)) {
      return {
        status: "unknown",
        confidence: "low",
        warnings,
        reason: `no size mapping for brand "${q.brand.trim()}"`,
      };
    }
    const rows = this.byBrandGender.get(KEY(brand, q.gender));
    if (!rows || rows.length === 0) {
      const other: Gender = q.gender === "men" ? "women" : "men";
      const hasOther = this.byBrandGender.has(KEY(brand, other));
      return {
        status: "unknown",
        confidence: "low",
        warnings,
        resolvedBrand: brand,
        reason: hasOther
          ? `${this.brandLabel(brand)} is ${other}'s-only in this dataset — no ${q.gender}'s rows`
          : `no ${q.gender}'s size mapping for ${this.brandLabel(brand)}`,
      };
    }

    const sorted = [...rows].sort((a, b) => a.footLengthMm - b.footLengthMm);
    const nearest = sorted.reduce((best, r) =>
      Math.abs(r.footLengthMm - q.footLengthMm) < Math.abs(best.footLengthMm - q.footLengthMm) ? r : best,
    );
    const pack = (r: SizeRow) => ({ us: r.us, uk: r.uk, eu: r.eu, offersWidthGrades: r.offersWidthGrades });

    if (Math.abs(nearest.footLengthMm - q.footLengthMm) <= tol) {
      return {
        status: "exact",
        ...pack(nearest),
        label: `US ${nearest.us}`,
        resolvedBrand: brand,
        confidence: "high",
        warnings,
      };
    }

    const lo0 = sorted[0];
    const hi0 = sorted[sorted.length - 1];
    if (q.footLengthMm > lo0.footLengthMm && q.footLengthMm < hi0.footLengthMm) {
      let lo = lo0;
      let hi = hi0;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].footLengthMm < q.footLengthMm && sorted[i + 1].footLengthMm > q.footLengthMm) {
          lo = sorted[i];
          hi = sorted[i + 1];
          break;
        }
      }
      return {
        status: "interpolated",
        ...pack(hi),
        label: `between US ${lo.us} and US ${hi.us} — size up to US ${hi.us}`,
        resolvedBrand: brand,
        confidence: "high",
        warnings,
      };
    }

    const edge = q.footLengthMm <= lo0.footLengthMm ? lo0 : hi0;
    warnings.push(
      `${q.footLengthMm} mm is outside ${this.brandLabel(brand)} ${q.gender}'s mapped range ` +
        `(${lo0.footLengthMm}–${hi0.footLengthMm} mm)`,
    );
    return {
      status: "extrapolated",
      ...pack(edge),
      label: `US ${edge.us} (range edge)`,
      resolvedBrand: brand,
      confidence: "low",
      warnings,
    };
  }
}

// ------------------------------------------------------ profile from fit data

export interface FitStatement {
  brand: string;
  gender: Gender;
  system: SizeSystem;
  value: number;
  /** The MVP only acts on "fits"; "tight" / "loose" are reserved for later. */
  verdict?: "fits" | "tight" | "loose";
}

export interface ResolvedFit {
  statement: FitStatement;
  status: ResolveStatus;
  footLengthMm?: number;
  confidence: Confidence;
  warnings: string[];
}

export interface FootEstimate {
  status: "ok" | "conflict" | "unresolved";
  /** Intersection of each fitting shoe's tolerance band, in mm. */
  low?: number;
  high?: number;
  /** Midpoint of [low, high] when "ok"; mean of the raw points on "conflict". */
  bestMm?: number;
  resolved: ResolvedFit[];
  warnings: string[];
}

/**
 * Turn "these shoes fit me" into a foot-length estimate. Each fitting shoe is
 * resolved to a length and given a +/- `toleranceMm` band; the estimate is the
 * intersection of those bands. Bands that don't overlap -> status "conflict"
 * (the caller still gets a `bestMm` from the raw mean, plus a warning). This is
 * the multi-statement intersection the UI runs every time a user reports a fit.
 */
export function estimateFootLength(
  table: SizeTable,
  fits: FitStatement[],
  toleranceMm = 4,
): FootEstimate {
  const warnings: string[] = [];
  const resolved: ResolvedFit[] = fits.map((s) => {
    const r = table.resolve(s);
    return { statement: s, status: r.status, footLengthMm: r.footLengthMm, confidence: r.confidence, warnings: r.warnings };
  });

  const points = resolved.filter(
    (r): r is ResolvedFit & { footLengthMm: number } => r.footLengthMm !== undefined,
  );
  for (const r of resolved) {
    if (r.footLengthMm === undefined) {
      warnings.push(
        `ignored ${r.statement.brand} ${r.statement.system.toUpperCase()} ${r.statement.value}: unresolved`,
      );
    }
  }
  if (points.length === 0) return { status: "unresolved", resolved, warnings };

  const low = Math.max(...points.map((p) => p.footLengthMm - toleranceMm));
  const high = Math.min(...points.map((p) => p.footLengthMm + toleranceMm));
  const rawMean = points.reduce((n, p) => n + p.footLengthMm, 0) / points.length;

  if (low > high) {
    warnings.push(
      `fit statements disagree by more than ${2 * toleranceMm} mm ` +
        `(${points.map((p) => `${p.statement.brand} ${p.footLengthMm} mm`).join(", ")})`,
    );
    return { status: "conflict", low: round1(low), high: round1(high), bestMm: round1(rawMean), resolved, warnings };
  }
  return { status: "ok", low: round1(low), high: round1(high), bestMm: round1((low + high) / 2), resolved, warnings };
}

// ------------------------------------------------------------- label parsing

export interface ParsedLabel {
  system: SizeSystem;
  value: number;
  /** True when the system was guessed from magnitude, not stated. */
  ambiguous: boolean;
}

/**
 * Best-effort read of a freeform catalog label into { system, value }. Catalog
 * size labels have no schema (the UCP README and Sizely both stress this), so
 * this is heuristic and deliberately small:
 *
 *   - explicit token wins:  "US 9", "9 US", "UK9", "EU 42", "42 EUR"
 *   - EU fraction forms:     "42 2/3", "42 2/3", "42.5"
 *   - bare number >= 33   -> eu
 *   - bare number  < 33   -> us (ambiguous with uk; US is the safe default for
 *                            the US storefronts this runs against)
 *
 * Returns null when the label carries no number.
 */
export function parseSizeLabel(raw: string): ParsedLabel | null {
  const t = raw.trim().toLowerCase();

  let system: SizeSystem | null = null;
  if (/\b(us|u\.s\.|usa|american)\b/.test(t)) system = "us";
  else if (/\b(uk|gb|british)\b/.test(t)) system = "uk";
  else if (/\b(eu|eur|euro|europe(an)?)\b/.test(t)) system = "eu";

  let frac = 0;
  const fm = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (fm) frac = Number(fm[1]) / Number(fm[2]);

  const nm = t.match(/\d+(?:\.\d+)?/);
  if (!nm) return null;
  const value = Math.round((Number(nm[0]) + frac) * 100) / 100;

  let ambiguous = false;
  if (!system) {
    if (value >= 33) {
      system = "eu";
    } else {
      system = "us";
      ambiguous = true;
    }
  }
  return { system, value, ambiguous };
}
