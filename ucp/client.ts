/**
 * UCP catalog client.
 *
 * Every request must advertise our platform profile:
 *   REST -> `UCP-Agent: profile="https://..."` (RFC 8941 dictionary syntax)
 *   MCP  -> arguments.meta["ucp-agent"].profile
 *
 * IMPORTANT: there is no standard size filter. Search filters are `categories`
 * and `price` only. Fit matching therefore happens on our side, after retrieval,
 * which is what `searchUntil` below exists for.
 */

import {
  NegotiatedStore,
  UcpContext,
  UcpError,
  UcpGetProductResponse,
  UcpLookupResponse,
  UcpProduct,
  UcpSearchRequest,
  UcpSearchResponse,
  UcpSelectedOption,
} from "./types.js";
import { CATALOG_LOOKUP, CATALOG_SEARCH, PLATFORM_PROFILE_URL } from "./negotiate.js";

const DEFAULT_TIMEOUT_MS = 15_000;

function requireCapability(store: NegotiatedStore, name: string) {
  if (!(name in store.capabilities)) {
    throw new UcpError(
      `${store.domain} did not negotiate ${name}`,
      "capabilities_incompatible",
    );
  }
}

// ---------------------------------------------------------------- transport calls

async function callRest<T>(
  store: NegotiatedStore,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${store.endpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "UCP-Agent": `profile="${PLATFORM_PROFILE_URL}"`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new UcpError(`${store.domain}${path} failed`, "request_failed", err);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UcpError(
      `${store.domain}${path} returned non-JSON (${res.status})`,
      "request_failed",
      text.slice(0, 500),
    );
  }

  // Negotiation failure is reported as HTTP 200 with the error in the body, so
  // status alone is not enough to decide success.
  if (!res.ok) {
    throw new UcpError(
      `${store.domain}${path} returned ${res.status}`,
      "request_failed",
      parsed,
    );
  }
  return parsed as T;
}

/**
 * MCP binding. Verified against Shopify's Storefront Catalog docs: tool names
 * (`search_catalog`, `lookup_catalog`, `get_product`), the `meta.ucp-agent`
 * envelope, request params wrapped in a `catalog` object, and results in
 * `result.structuredContent`. Shopify's endpoint is `{store}/api/ucp/mcp` and is
 * MCP-only, so this path — not REST — is what actually runs against Shopify.
 * Still unverified: whether an MCP `initialize` handshake is required first.
 */
async function callMcp<T>(
  store: NegotiatedStore,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(store.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: tool,
          arguments: {
            meta: { "ucp-agent": { profile: PLATFORM_PROFILE_URL } },
            catalog: args,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new UcpError(`${store.domain} MCP ${tool} failed`, "request_failed", err);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await res.json()) as {
    error?: { code: number; message: string };
    result?: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  };

  if (payload.error) {
    throw new UcpError(
      `${store.domain} MCP ${tool}: ${payload.error.message}`,
      "request_failed",
      payload.error,
    );
  }

  const structured = payload.result?.structuredContent;
  if (structured) return structured as T;

  const text = payload.result?.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      /* fall through */
    }
  }
  throw new UcpError(`${store.domain} MCP ${tool} returned no usable result`, "request_failed", payload);
}

// ---------------------------------------------------------------- operations

export interface CallOptions {
  timeoutMs?: number;
}

export async function searchCatalog(
  store: NegotiatedStore,
  request: UcpSearchRequest,
  opts: CallOptions = {},
): Promise<UcpSearchResponse> {
  requireCapability(store, CATALOG_SEARCH);

  // A valid search must carry at least one of: query, filters, or an extension input.
  if (!request.query && !request.filters) {
    throw new UcpError("Search needs a query or at least one filter", "request_failed");
  }

  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return store.transport === "rest"
    ? callRest<UcpSearchResponse>(store, "/catalog/search", request, timeout)
    : callMcp<UcpSearchResponse>(store, "search_catalog", request, timeout);
}

export async function lookupCatalog(
  store: NegotiatedStore,
  ids: string[],
  opts: CallOptions = {},
): Promise<UcpLookupResponse> {
  requireCapability(store, CATALOG_LOOKUP);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = { ids };
  return store.transport === "rest"
    ? callRest<UcpLookupResponse>(store, "/catalog/lookup", body, timeout)
    : callMcp<UcpLookupResponse>(store, "lookup_catalog", body, timeout);
}

/**
 * Authoritative single-product read — full variant detail for a purchase decision.
 * This is what a fit verdict should be based on, not a search-result summary.
 *
 * `selected` narrows to specific option values, e.g. [{name:"Size", label:"10"}].
 * The response's `product.options[].values[]` carry `available` and `exists`
 * signals — distinguish them: `exists:false` means they don't make your size,
 * `available:false` means it's sold out. Different fit verdicts.
 */
export async function getProduct(
  store: NegotiatedStore,
  id: string,
  opts: CallOptions & { selected?: UcpSelectedOption[]; context?: UcpContext } = {},
): Promise<UcpGetProductResponse> {
  requireCapability(store, CATALOG_LOOKUP);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = {
    id,
    ...(opts.selected ? { selected: opts.selected } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  };
  return store.transport === "rest"
    ? callRest<UcpGetProductResponse>(store, "/catalog/product", body, timeout)
    : callMcp<UcpGetProductResponse>(store, "get_product", body, timeout);
}

/** Option value with the availability signals get_product returns. */
export interface OptionValueSignal {
  label: string;
  /** In stock right now. */
  available?: boolean;
  /** The merchant makes this combination at all. */
  exists?: boolean;
}

/**
 * Pull the size option's value matrix out of a get_product response. Returns
 * undefined when the product declares no size-like option — a real state, not
 * an error, since `options` is optional throughout UCP.
 */
export function sizeMatrix(
  product: UcpProduct,
  isSizeName: (name: string) => boolean,
): { optionName: string; values: OptionValueSignal[] } | undefined {
  const option = product.options?.find((o) => isSizeName(o.name.trim()));
  if (!option) return undefined;
  return {
    optionName: option.name,
    values: option.values as OptionValueSignal[],
  };
}

// ---------------------------------------------------------------- over-fetch

export interface SearchUntilResult {
  /** Products that passed the predicate, capped at `want`. */
  matched: UcpProduct[];
  /** Everything retrieved, for "searched 40, 6 fit" reporting. */
  scanned: number;
  pages: number;
  exhausted: boolean;
  messages: UcpSearchResponse["messages"];
}

/**
 * Fetch pages until `want` products satisfy `predicate`, or we run out.
 *
 * Necessary because fit isn't filterable at the source. Note that `limit` is a
 * request, not a guarantee — the store may return fewer than asked on any page,
 * so termination keys off has_next_page and the page cap, never off page size.
 */
export async function searchUntil(
  store: NegotiatedStore,
  request: UcpSearchRequest,
  predicate: (p: UcpProduct) => boolean,
  { want = 6, maxPages = 5, pageSize = 20 }: { want?: number; maxPages?: number; pageSize?: number } = {},
): Promise<SearchUntilResult> {
  const matched: UcpProduct[] = [];
  const messages: NonNullable<UcpSearchResponse["messages"]> = [];
  let cursor: string | undefined;
  let scanned = 0;
  let pages = 0;
  let exhausted = false;

  while (pages < maxPages && matched.length < want) {
    const res = await searchCatalog(store, {
      ...request,
      pagination: { limit: pageSize, ...(cursor ? { cursor } : {}) },
    });

    pages += 1;
    scanned += res.products.length;
    if (res.messages?.length) messages.push(...res.messages);

    for (const product of res.products) {
      if (matched.length >= want) break;
      if (predicate(product)) matched.push(product);
    }

    if (!res.pagination?.has_next_page || !res.pagination.cursor) {
      exhausted = true;
      break;
    }
    cursor = res.pagination.cursor;
  }

  return { matched, scanned, pages, exhausted, messages };
}

/**
 * Minor units -> display string. Never render `price.amount` directly.
 * The exponent is per-currency (USD 2, JPY 0, KWD 3), so derive it rather than
 * dividing by 100 and shipping a 100x error on yen.
 */
export function formatPrice(price: { amount: number; currency: string }, locale = "en-US"): string {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency: price.currency });
  const exponent = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(price.amount / 10 ** exponent);
}
