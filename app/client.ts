import type {
  CatalogProduct,
  CheckFitResponse,
  EstimateResponse,
  FitStatement,
  Gender,
  RecommendResponse,
} from "./types";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status} ${path}`);
  return json as T;
}

export function estimate(
  statements: Array<Pick<FitStatement, "brand" | "gender" | "system" | "value">>,
): Promise<EstimateResponse> {
  return post("/api/estimate", { statements });
}

export function search(
  domain: string,
  query: string,
  profile?: { footLengthMm?: number; gender?: Gender | null },
): Promise<{
  domain: string;
  query: string;
  scanned: number;
  matched: number;
  count: number;
  products: CatalogProduct[];
}> {
  return post("/api/search", {
    domain,
    query,
    footLengthMm: profile?.footLengthMm,
    gender: profile?.gender ?? undefined,
  });
}

export function checkFit(
  domain: string,
  productId: string,
  profile: { footLengthMm?: number; gender?: Gender | null },
): Promise<CheckFitResponse> {
  return post("/api/check-fit", {
    domain,
    productId,
    footLengthMm: profile.footLengthMm,
    gender: profile.gender ?? undefined,
  });
}

export function negotiate(domain: string): Promise<{
  domain: string;
  protocolVersion: string;
  transport: string;
  capabilities: Record<string, string>;
  warnings: string[];
}> {
  return post("/api/negotiate", { domain });
}

export function recommend(
  brand: string,
  gender: Gender,
  footLengthMm: number,
): Promise<RecommendResponse> {
  return post("/api/recommend", { brand, gender, footLengthMm });
}
