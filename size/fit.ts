/**
 * size/fit.ts — a per-product fit verdict.
 *
 * Given a shopper's foot length + gender (from the profile, never the catalog)
 * and a product's Size run, decide whether the shoe fits and which label to
 * buy. Rounds up: a shoe at least as long as the foot is wearable, a shorter
 * one is not.
 *
 * `checkFit` is pure. The caller (server/routes.ts) does the catalog reads and
 * hands over: the full run of listed labels, and whatever per-size
 * availability it could determine.
 */

import { canonicalBrand, type Gender, type SizeSystem, type SizeTable } from "./resolver.js";

export type Verdict =
  | "fits"
  | "size_up"
  | "size_down"
  | "between_sizes"
  | "no_size"
  | "out_of_stock"
  | "unmapped_brand"
  | "unknown";

export type NumberingSystem = "us/uk" | "eu" | "mixed" | "alpha" | "none";

/** Per-size availability, when the catalog gives it. */
export interface SizeAvailability {
  /** The merchant makes this size at all. `false` => "they don't make your size". */
  exists: boolean;
  /** In stock right now. `false` => "your size is sold out". */
  available: boolean;
}

export interface CheckFitInput {
  brand: string;
  gender: Gender | null;
  footLengthMm: number | null;
  /** Every Size label the product lists — defines the run and the numbering system. */
  runLabels: string[];
  /**
   * Availability keyed by the numeric size value, for whatever sizes the caller
   * resolved (at least the target and its neighbours). A value absent here has
   * unknown stock — treated as listed-and-available.
   */
  availability?: Record<number, SizeAvailability>;
}

export interface FitVerdict {
  verdict: Verdict;
  numberingSystem: NumberingSystem;
  /** e.g. "US 9" or "EU 42". Null when nothing could be recommended. */
  recommendedLabel: string | null;
  /** Foot length of the recommended size, mm. */
  sizeLengthMm: number | null;
  /** sizeLengthMm - footLengthMm. Positive = wearable slack. */
  headroomMm: number | null;
  /** One plain sentence for the UI. */
  sentence: string;
}

const ALPHA = /^(x*s|s|m|l|x*l|o\/s|one size|osfa)$/i;

/** Read a run's numbering system from the shape of the whole set. */
export function inferNumberingSystem(labels: string[]): NumberingSystem {
  const nums = labels
    .map((l) => l.match(/^\s*(\d+(?:\.\d+)?)/))
    .map((m) => (m ? Number(m[1]) : null))
    .filter((n): n is number => n !== null);

  if (nums.length === 0) {
    return labels.some((l) => ALPHA.test(l.trim())) ? "alpha" : "none";
  }
  const inEu = nums.every((n) => n >= 33 && n <= 52);
  const inUs = nums.every((n) => n >= 1 && n <= 20);
  if (inEu) return "eu";
  if (inUs) return "us/uk";
  return "mixed";
}

function parseNum(label: string): number | null {
  const m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function checkFit(input: CheckFitInput, table: SizeTable): FitVerdict {
  const system = inferNumberingSystem(input.runLabels);
  const base = { numberingSystem: system, recommendedLabel: null, sizeLengthMm: null, headroomMm: null };

  const brandKey = canonicalBrand(input.brand).key;
  if (!input.brand || !table.brandKeys().includes(brandKey)) {
    return {
      ...base,
      verdict: "unmapped_brand",
      sentence: input.brand
        ? `No size mapping for ${input.brand} — can't check fit.`
        : `Couldn't identify the brand — can't check fit.`,
    };
  }
  if (input.footLengthMm == null) {
    return { ...base, verdict: "unknown", sentence: `Add a fit you know first — we need your foot length.` };
  }
  if (system !== "us/uk" && system !== "eu") {
    return {
      ...base,
      verdict: "unknown",
      sentence: `This product's size labels aren't a shoe run we can read (${system}).`,
    };
  }

  const gender: Gender = input.gender ?? "men";
  const resolveSystem: SizeSystem = system === "eu" ? "eu" : "us";
  const rec = table.recommend({ brand: input.brand, gender, footLengthMm: input.footLengthMm });

  if (rec.status === "unknown") {
    return {
      ...base,
      verdict: "unknown",
      sentence: rec.reason ? capitalize(rec.reason) + "." : `Can't resolve a size for ${input.brand}.`,
    };
  }

  const targetNum = resolveSystem === "eu" ? rec.eu! : rec.us!;
  const label = (n: number) => (resolveSystem === "eu" ? `EU ${n}` : `US ${n}`);

  const runNums = [...new Set(input.runLabels.map(parseNum).filter((n): n is number => n != null))].sort(
    (a, b) => a - b,
  );
  if (runNums.length === 0) {
    return { ...base, verdict: "unknown", sentence: `This product lists no readable sizes.` };
  }

  const min = runNums[0];
  const max = runNums[runNums.length - 1];
  const av = input.availability ?? {};

  // Foot longer than anything this brand is mapped for.
  if (rec.status === "beyond_range") {
    return {
      ...base,
      verdict: "no_size",
      recommendedLabel: label(targetNum),
      sizeLengthMm: rec.sizeLengthMm ?? null,
      headroomMm: rec.headroomMm ?? null,
      sentence: `Your foot is longer than ${cap(input.brand)}'s largest mapped size (${label(targetNum)}).`,
    };
  }

  // Foot outside what this shoe is offered in.
  if (targetNum > max || targetNum < min) {
    return {
      ...base,
      verdict: "no_size",
      recommendedLabel: label(targetNum),
      sizeLengthMm: rec.sizeLengthMm ?? null,
      headroomMm: rec.headroomMm ?? null,
      sentence:
        targetNum > max
          ? `Your foot needs about ${label(targetNum)}; this shoe runs ${label(min)}–${label(max)}.`
          : `This shoe starts at ${label(min)}; your foot is smaller than that.`,
    };
  }

  // Target size is one this product lists.
  if (runNums.includes(targetNum)) {
    const a = av[targetNum];
    if (a && a.exists === false) {
      return {
        ...base,
        verdict: "no_size",
        recommendedLabel: label(targetNum),
        sizeLengthMm: rec.sizeLengthMm ?? null,
        headroomMm: rec.headroomMm ?? null,
        sentence: `${cap(input.brand)} lists ${label(targetNum)} but doesn't make it in this shoe.`,
      };
    }
    if (a && a.available === false) {
      return {
        ...base,
        verdict: "out_of_stock",
        recommendedLabel: label(targetNum),
        sizeLengthMm: rec.sizeLengthMm ?? null,
        headroomMm: rec.headroomMm ?? null,
        sentence: `Your size (${label(targetNum)}) is sold out in this shoe.`,
      };
    }
    return {
      ...base,
      verdict: "fits",
      recommendedLabel: label(targetNum),
      sizeLengthMm: rec.sizeLengthMm ?? null,
      headroomMm: rec.headroomMm ?? null,
      sentence: `Your size is ${label(targetNum)} — ${rec.sizeLengthMm} mm, ${signed(rec.headroomMm)} mm room.`,
    };
  }

  // Target isn't a listed size — it falls between two the product does list
  // (e.g. a whole-sizes-only run). bracketDown/bracketUp are those two;
  // availability decides which one we actually steer to.
  const gettable = (n: number) => {
    const a = av[n];
    return !a || (a.exists !== false && a.available !== false);
  };
  const bracketDown = [...runNums].reverse().find((n) => n < targetNum)!;
  const bracketUp = runNums.find((n) => n > targetNum)!;

  const withNeighbour = (n: number, verdict: Verdict, sentence: string): FitVerdict => {
    const r = table.resolve({ brand: input.brand, gender, system: resolveSystem, value: n });
    const mm = r.footLengthMm ?? null;
    return {
      ...base,
      verdict,
      recommendedLabel: label(n),
      sizeLengthMm: mm,
      headroomMm: mm == null ? null : round1(mm - input.footLengthMm!),
      sentence,
    };
  };

  if (gettable(bracketUp)) {
    return withNeighbour(
      bracketUp,
      "between_sizes",
      `Your foot is between ${label(bracketDown)} and ${label(bracketUp)} — size up to ${label(bracketUp)}.`,
    );
  }
  if (gettable(bracketDown)) {
    return withNeighbour(
      bracketDown,
      "size_down",
      `The ${label(bracketUp)} above your fit is gone; the ${label(bracketDown)} will run snug.`,
    );
  }
  // Both immediate neighbours are unavailable — widen the search.
  const nextUp = runNums.find((n) => n > bracketUp && gettable(n));
  if (nextUp != null) {
    return withNeighbour(
      nextUp,
      "size_up",
      `The sizes next to your fit are gone; the ${label(nextUp)} is the closest available and will run loose.`,
    );
  }
  const nextDown = [...runNums].reverse().find((n) => n < bracketDown && gettable(n));
  if (nextDown != null) {
    return withNeighbour(
      nextDown,
      "size_down",
      `The sizes next to your fit are gone; only the ${label(nextDown)} is left and it will run snug.`,
    );
  }
  return {
    ...base,
    verdict: "out_of_stock",
    recommendedLabel: label(targetNum),
    sentence: `The sizes around your fit are all sold out in this shoe.`,
  };
}

function signed(n: number | undefined): string {
  if (n == null) return "?";
  return n >= 0 ? `+${n}` : `${n}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const capitalize = cap;
