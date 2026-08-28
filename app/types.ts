// Client-facing shapes. The server owns the real logic (size/resolver.ts,
// ucp/*); these mirror just what the browser needs so the bundle carries no
// node dependencies.

export type Gender = "men" | "women";
export type SizeSystem = "us" | "uk" | "eu";
export type Width = "narrow" | "standard" | "wide";

/** One "this size fits me" report, as shown in the profile panel. */
export interface FitStatement {
  id: string;
  brand: string;
  gender: Gender;
  system: SizeSystem;
  value: number;
  /** Filled in by the server once resolved against size/. */
  footLengthMm?: number;
  resolveStatus?: "exact" | "interpolated" | "extrapolated" | "unknown";
  note?: string;
}

export interface FootLengthRange {
  low: number;
  high: number;
  bestMm?: number;
}

export type EstimateStatus = "empty" | "ok" | "conflict" | "unresolved";

export interface FitProfile {
  gender: Gender | null;
  width: Width | null;
  footLength: FootLengthRange | null;
  estimateStatus: EstimateStatus;
  /** Set when estimateStatus === "conflict". */
  conflictNote?: string;
  statements: FitStatement[];
}

// ---- server response shapes ------------------------------------------------

export interface EstimateResponse {
  status: EstimateStatus;
  low?: number;
  high?: number;
  bestMm?: number;
  spreadMm?: number;
  conflictNote?: string;
  resolved: Array<{
    index: number;
    footLengthMm?: number;
    status: FitStatement["resolveStatus"];
    note?: string;
  }>;
}

export interface CatalogProduct {
  id: string;
  title: string;
  brand: string;
  url?: string;
  sizeOptionName: string | null;
  sizeLabels: string[];
}

export interface RecommendResponse {
  status: "exact" | "rounded_up" | "beyond_range" | "unknown";
  us?: number;
  uk?: number;
  eu?: number;
  sizeLengthMm?: number;
  headroomMm?: number;
  label?: string;
  reason?: string;
}
