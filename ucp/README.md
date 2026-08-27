# UCP layer — fit manifest

Server-side UCP client. The fit app is a UCP **Platform**: it discovers stores,
negotiates capabilities, and reads their catalogs. Merchants install nothing.

```
platform-profile.json   what we advertise — must be hosted at a public HTTPS URL
types.ts                minimal UCP types (profiles, products, variants)
negotiate.ts            discovery, protocol version fallback, capability intersection
client.ts               REST + MCP catalog calls, over-fetch paging, price formatting
probe.ts                day-1 script: what stores advertise, and is size data actually there
```

## Setup

Node 18+ (native `fetch`), TypeScript with `"module": "nodenext"` for the JSON
import attribute in `negotiate.ts`.

1. Host `platform-profile.json` at a stable HTTPS URL.
2. Set `UCP_PLATFORM_PROFILE_URL` to that URL. Every request advertises it —
   over REST as `UCP-Agent: profile="..."`, over MCP as `arguments.meta["ucp-agent"]`.
3. Run the probe before writing anything downstream:

```bash
npx tsx ucp/probe.ts <your-confirmed-domains> --query "t-shirt"
```

Then use it:

```ts
const store = await negotiateStore("example-store.com");
const { matched, scanned } = await searchUntil(
  store,
  { query: "oxford shirt", context: { address_country: "CA", intent: "size L, prefers relaxed" } },
  (product) => fits(product, profile),
  { want: 6 },
);
// "searched 40, 6 fit" — scanned is the number worth showing the user
```

## Two things that will cost you a day if you skip them

**Version mismatch is silent.** Negotiation intersects capabilities by name *and*
version, and a capability with no mutual version is dropped rather than erroring.
The symptom is "this store has no catalog search," not "you advertised the wrong
date." `platform-profile.json` therefore lists every catalog version we know of;
run the probe and add any it reports as advertised-but-not-negotiated.
Relatedly, `capabilities_incompatible` comes back as **HTTP 200** with the failure
in the body, so never branch on status alone.

**There is no size filter.** Standard search filters are `categories` and `price`.
Fit is filtered client-side after retrieval — hence `searchUntil`. And `limit` is a
requested page size, not a guarantee: the store may return fewer on any page, so
termination keys off `has_next_page`, never off the count you got back.

## Deliberately not implemented

Documented as scoping choices, not oversights:

- **Schema fetch + allOf composition.** The spec asks platforms to fetch each
  capability's declared JSON Schema and compose active extensions before
  validating requests and responses. We hand-parse defensively instead.
- **Authority binding checks** on declared schema URLs — only relevant if you
  dereference them, which we don't.
- **Identity linking / authenticated scopes** (`catalog.search:read` for
  personalized results and member pricing). OAuth flow, no payoff here.
- **Cart, checkout, orders, payment.** Read-only by design.

## Known-shaky bits

- Schema URLs in `platform-profile.json` follow the pattern from the spec's own
  profile examples; exact filenames are inferred. `curl` them.
- The MCP envelope is now verified against Shopify's Storefront Catalog docs
  (params wrap in a `catalog` object next to `meta`). Still unverified: whether
  an MCP `initialize` handshake is needed before `tools/call`.
- Shopify serves UCP over MCP only, at `{store}/api/ucp/mcp`. The REST path here
  is for non-Shopify businesses that advertise a rest binding.
- `resolveSize` in `probe.ts` is a hypothesis about which option names mean
  "size." Let the probe output correct it — that's what it's for.

## What the catalog does and doesn't give you for fit

Size labels are freeform strings (`{"name": "Size", "values": [{"label": "8"}]}`)
with no taxonomy, unit, or region. That's the normalizer's job and it doesn't go
away. Three things do help:

- `get_product` returns each option value with `available` and `exists`. Keep them
  distinct: `exists: false` means they never made your size, `available: false`
  means it's out of stock. Different verdicts, different follow-ups.
- `catalog.selected` narrows a product by option value, so single-product fit
  checks are cheap even though search can't filter by size.
- `categories` carry real taxonomy ids (`google_product_category`, `shopify`,
  `merchant`) side by side, so footwear-vs-apparel routing is reliable.
