# Fit Check

**A shoe fit profile the buyer owns, not the merchant.**

Live: [fitcheck-gray.vercel.app](https://fitcheck-gray.vercel.app) · Demo video:
_(add link)_

Built for the OpenAI WebMCP Challenge, September 2026.

---

## The problem

These are seven real shoes, all labelled **men's US 9**:

```
Nike           263 mm
Salomon        264 mm
Converse       265 mm
ASICS          268 mm
Adidas         270 mm
Birkenstock    270 mm
New Balance    270 mm
```

Seven millimetres of spread on an identical label.

Now the part that's worse. Reading Kith's live catalog, every US-family
product uses the same `3–18` size axis regardless of whether it's tagged
`mens`, `wmns`, or both — and most are tagged both. So a bare label `7` is
ambiguous between men's and women's. That's about **15 mm inside a single
brand** — wider than the spread across all seven.

The catalog structurally cannot tell you which. Neither can the agent
shopping on your behalf.

That fact has to come from the shopper. It is the clearest example of
something that only exists on the buyer's side of the transaction — and
nothing in the commerce stack is built to hold it.

## What this is

Every agentic commerce protocol shipped in the last eighteen months
standardises the merchant: UCP and ACP for the shopping journey, AP2 for
payment authorization, x402 for settlement. None of them model the buyer
past a payment instrument and a shipping address.

Fit Check is the smallest useful version of the buyer's half.

- The person enters shoes they already own that fit. **Never millimetres** —
  brands and sizes, which sneaker shoppers know from memory.
- Those statements resolve to a **foot length range in millimetres**, the
  canonical stored value. Brand labels resolve *against* that length. Labels
  never convert directly to other labels.
- Any shopping agent can read the profile, write to it, and check products
  against it through **WebMCP tools registered on the page**.
- The server reads any store's **UCP catalog**. Merchants install nothing.
- When a verdict is wrong, the person says so and the profile updates. It
  sharpens across stores instead of being rebuilt at each one.

## Why the architecture is inverted

WebMCP tools are scoped to a document. An agent on a merchant's page cannot
see tools registered by another origin, and cross-tab visibility is
unspecified.

So Fit Check is the page the agent works on, and the server reaches out to
stores. The merchant is never in the loop — which is also what makes the
portability claim true rather than aspirational. There is no integration to
sell, no widget to install, and no store that has to say yes.

## Verified against live stores

Nothing here is mocked. Every number below came from a real UCP catalog read.

| Store | Protocol | Size data | Brand coverage |
|---|---|---|---|
| `kith.com` | 2026-08-25 | 100% clean `variant.options` | 95% |
| `stompingground.myshopify.com` | 2026-08-25 | 100% clean, option named `Shoe Size` | 80% |
| `knifewear-inc.myshopify.com` | 2026-08-25 | no size axis at all | n/a — degrades to `unknown` |

The knife shop is included on purpose: it's a store sharing none of the
assumptions, and the layer negotiates, reads it, and correctly reports that
it has nothing to say.

## The tools

Registered on `document.modelContext`, falling back to
`navigator.modelContext`.

| Tool | |
|---|---|
| `get_fit_profile` | read the profile · `readOnlyHint` |
| `update_fit_profile` | gender, width, measurements |
| `add_fit_statement` | "Nike 9 fits" → resolves to a length |
| `remove_fit_statement` | |
| `check_fit` | one product, authoritative · `untrustedContentHint` |
| `search_catalog` | search a store, verdicts attached · `untrustedContentHint` |
| `recommend_size` | what to buy in a given brand |

Verdicts are deliberately not binary:

```
fits · size_up · size_down · between_sizes · no_size
out_of_stock · unmapped_brand · unknown
```

Design decisions worth naming:

- **Rounding is always up.** A shoe shorter than your foot doesn't fit; one
  slightly long is wearable. A property test sweeps 240–300 mm across all
  seven brands asserting no recommendation is ever shorter than the foot.
- **Conflicting statements produce a question, not an average.** If your Nike
  9 and your Converse 9.5 disagree by more than a half size, the tool says so
  and asks which fits better. Only the person can answer that, and answering
  it improves the profile permanently.
- **`unmapped_brand` is a real answer.** Veja appears on Stomping Ground and
  there's no mapping for it. Saying so beats guessing.
- **Both feet are recorded separately.** Most people differ by several
  millimetres and no sizing tool acknowledges it.

## Running it

```bash
npm install
npm run dev          # API on 8787, Vite proxying /api
npm test             # 27 tests
npm run demo         # the seven-brand spread, worked end to end
npx tsx ucp/probe.ts kith.com --query "sneakers"
```

## Layout

```
app/      Vite + React. Chat left, profile panel right.
          The panel updates live as the agent writes to it.
size/     The resolver. Foot length in, brand labels out.
ucp/      Discovery, capability negotiation, catalog reads.
server/   API wrapping ucp/ and size/. The browser never calls Shopify.
api/      The same routes as a Vercel serverless function.
```

## What isn't built, on purpose

- No cart, checkout, payment, or orders. Read-only.
- No apparel. Footwear only — it's where fit costs the most.
- No JSON Schema fetching or `allOf` composition. UCP asks platforms to
  compose extension schemas before validating; this hand-parses defensively
  instead.
- No identity linking or authenticated scopes.
- No accounts. The profile is in-page state, and it's meant to be exportable.

## Data

Brand-to-foot-length mappings for Nike, Adidas, New Balance, Converse, ASICS,
Birkenstock, and Salomon come from a read-only sample shared by
**[Size AI / Sizely](https://sizeai.co)** for this submission, with thanks to
Eddy. Their guidance shaped the design: resolve on foot length rather than
labels, read Birkenstock via EU because its own US labels are internally
inconsistent, alias Jordan to Nike, and leave out the women's rows they
didn't trust rather than invent them.

## Where this goes

The right long-term home for a buyer profile is probably the browser — held
like autofill, queryable by any page's agent, with no app in between. The
spec isn't there yet: tools are document-scoped and cross-tab isolation is
still maturing.

But the schema outlives whoever holds it. Someone has to decide that the
canonical value is foot length rather than a size label, that both feet are
recorded, that statements carry provenance, and that an unresolvable brand
says so. That's the part this is really proposing.

The mechanism generalises past shoes. Any category where the reference data
is public and the person's half is missing — bike geometry against inseam,
knives against hand and board — has the same shape.
