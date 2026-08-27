/**
 * Minimal UCP type surface — only what the fit manifest needs.
 *
 * Deliberately NOT a full schema implementation. The spec asks platforms to fetch
 * each capability's declared JSON Schema and compose extension schemas via allOf
 * before validating. That's days of work; we hand-parse defensively instead and
 * document the simplification. Everything optional here is optional in the spec.
 */

// ---------------------------------------------------------------- profiles

export interface UcpEntity {
  version: string; // "YYYY-MM-DD" or "draft"
  spec?: string;
  schema?: string;
  id?: string;
  config?: Record<string, unknown>;
  /** Present on extensions, absent on root capabilities. */
  extends?: string | string[];
  /**
   * Minimum protocol version this entry needs. Seen on Kith's fulfillment,
   * discount, and dev.shopify.catalog entries.
   */
  requires?: { protocol?: { min?: string; max?: string } };
}

export type UcpTransport = "rest" | "mcp" | "a2a" | "embedded";

export interface UcpService extends UcpEntity {
  transport: UcpTransport;
  /** Optional in the spec — absent for the `embedded` transport. */
  endpoint?: string;
}

export interface UcpProfile {
  ucp: {
    version: string;
    services: Record<string, UcpService[]>;
    payment_handlers: Record<string, UcpEntity[]>;
    capabilities?: Record<string, UcpEntity[]>;
    /** Maps older protocol versions to version-specific profile URIs. */
    supported_versions?: Record<string, string>;
    [k: string]: unknown;
  };
  keys?: unknown[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------- catalog

/** Amount is in ISO 4217 MINOR units. 4995 USD is $49.95. Never render raw. */
export interface UcpPrice {
  amount: number;
  currency: string;
}

export interface UcpDescription {
  plain?: string;
  markdown?: string;
  html?: string;
}

export interface UcpMedia {
  type: string; // "image" | "video" | "model_3d"
  url: string;
  alt_text?: string;
  width?: number;
  height?: number;
}

/** Product-level option: the full set of values offered, e.g. Size -> S/M/L. */
export interface UcpProductOption {
  name: string; // freeform: "Size", "Shoe Size", "Talla"...
  values: Array<{ id?: string; label: string }>;
}

/** Variant-level option: the specific value this variant is, e.g. Size -> "Large". */
export interface UcpSelectedOption {
  name: string;
  id?: string;
  label: string;
}

export interface UcpVariant {
  id: string;
  title: string; // REQUIRED — e.g. "Blue / Large". The fallback when options[] is absent.
  description: UcpDescription;
  price: UcpPrice;
  sku?: string;
  handle?: string;
  url?: string;
  list_price?: UcpPrice;
  availability?: { available?: boolean; [k: string]: unknown };
  /** OPTIONAL. Do not assume presence — this is the whole problem. */
  options?: UcpSelectedOption[];
  media?: UcpMedia[];
  tags?: string[];
  /** Business-defined. Shopify hides its extension fields in here — worth probing. */
  metadata?: Record<string, unknown>;
  /** Present in lookup responses: which request ids resolved to this variant. */
  inputs?: Array<{ id?: string; match?: "exact" | "featured"; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface UcpProduct {
  id: string;
  title: string;
  description: UcpDescription;
  price_range: { min: UcpPrice; max: UcpPrice };
  variants: UcpVariant[]; // REQUIRED, first element is featured
  handle?: string;
  url?: string;
  categories?: Array<{ value?: string; [k: string]: unknown }>;
  media?: UcpMedia[];
  /** OPTIONAL. */
  options?: UcpProductOption[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface UcpMessage {
  type: "error" | "warning" | "info";
  code?: string;
  content: string;
  content_type?: "plain" | "markdown";
  path?: string;
  severity?:
    | "recoverable"
    | "requires_buyer_input"
    | "requires_buyer_review"
    | "unrecoverable";
  presentation?: "notice" | "disclosure";
  [k: string]: unknown;
}

export interface UcpSearchResponse {
  ucp: { version?: string; capabilities?: Record<string, unknown>; [k: string]: unknown };
  products: UcpProduct[];
  pagination?: { cursor?: string; has_next_page: boolean; total_count?: number };
  messages?: UcpMessage[];
  actions?: Record<string, Array<{ id: string; config?: unknown }>>;
  policies?: unknown[];
}

export interface UcpLookupResponse {
  ucp: Record<string, unknown>;
  products: UcpProduct[];
  messages?: UcpMessage[];
}

export interface UcpGetProductResponse {
  ucp: Record<string, unknown>;
  product: UcpProduct;
  messages?: UcpMessage[];
}

// ---------------------------------------------------------------- requests

/** Provisional, non-authoritative buyer signals. Keep non-identifying. */
export interface UcpContext {
  address_country?: string;
  address_region?: string;
  postal_code?: string;
  currency?: string;
  language?: string;
  /** Free text. Good place to carry fit intent: "size 10 US, prefers relaxed fit". */
  intent?: string;
  [k: string]: unknown;
}

export interface UcpSearchRequest {
  query?: string;
  context?: UcpContext;
  /** Only `categories` and `price` are standard. There is NO size filter. */
  filters?: {
    categories?: string[];
    price?: { min?: number; max?: number };
    [k: string]: unknown;
  };
  pagination?: { cursor?: string; limit?: number };
  [k: string]: unknown;
}

// ---------------------------------------------------------------- negotiated

export interface NegotiatedCapability {
  name: string;
  version: string;
  entry: UcpEntity;
}

export interface NegotiatedStore {
  domain: string;
  profileUrl: string;
  /** Protocol version the business advertised (or the one we fell back to). */
  protocolVersion: string;
  transport: "rest" | "mcp";
  endpoint: string;
  capabilities: Record<string, NegotiatedCapability>;
  /** Non-fatal problems worth surfacing in the UI / writeup. */
  warnings: string[];
  raw: UcpProfile;
}

export class UcpError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_profile_url"
      | "profile_unreachable"
      | "profile_malformed"
      | "version_unsupported"
      | "capabilities_incompatible"
      | "no_transport"
      | "request_failed",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "UcpError";
  }
}
