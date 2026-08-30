# app/ — the Fit Check page

One page: a chat column on the left, the fit profile panel on the right. An
agent drives it over WebMCP; the panel re-renders whenever a tool writes to the
store.

```
npm run dev        # api (8787) + vite (5173) together
npm run build      # -> dist/
npm run typecheck  # node code + app code
npm run demo:full  # the demo sequence through the real route bodies (steps 5–8 hit live stores)
```

`npm run demo:full` ([scripts/demo-full.ts](../scripts/demo-full.ts)) runs the
eight-step demo — profile, recommend, conflict, two live-store searches, two
`check_fit`s — through the same functions the server and the Vercel function
call. No browser, no mock. It's a rehearsal, a smoke test (a broken deploy fails
it), and something a reviewer can run themselves.

## Pieces

```
index.html / main.tsx     entry; installs the WebMCP tools before render
store.ts                  the fit profile as one observable object (useSyncExternalStore)
webmcp.ts                  the tool surface (see below)
client.ts                 fetch() wrappers for /api/*
components/ProfilePanel    reads the store: foot-length range, gender, width, statements (each removable)
components/ChatPanel       tool-activity feed + a few typed shortcuts for solo demos
../server/                 node:http API wrapping ucp/ and size/ — the browser never calls Shopify
../vite.config.ts          proxies ^/api/ to the API server
```

## WebMCP tools

Registered on `document.modelContext`, falling back to `navigator.modelContext`,
and always on `window.fitcheckMCP` (`.listTools()`, `.callTool(name, args)`) and
`window.fitcheckTools[name](args)` for console / test use.

Each descriptor carries `annotations`: `readOnlyHint` on every tool that doesn't
mutate the profile (`get_fit_profile`, `search_catalog`, `check_fit`,
`check_labels`, `negotiate_store`, `recommend_size`), and `untrustedContentHint`
on the three that carry third-party page text (`search_catalog`, `check_fit`,
`check_labels`).

| tool | writes | notes |
|---|---|---|
| `get_fit_profile` | — | current profile |
| `update_fit_profile` | gender, width, statements | `statements` replaces the list; `null` clears a field |
| `add_fit_statement` | one statement | `{brand, value, gender?, system?}`; defaults men / us |
| `remove_fit_statement` | — | by `id` |
| `reset_fit_profile` | — | clear everything |
| `search_catalog` | — | `{domain, query}` → server → ucp/; each product carries a `fit` verdict + `scanned`/`matched` when the profile has a foot length |
| `check_fit` | — | `{domain, product_id}` → deep per-product verdict (see below) |
| `check_labels` | — | `{brand, labels[], product_title?}` → same verdict, **no store access** — the caller supplies the run |
| `negotiate_store` | — | `{domain}` → server → ucp/ |
| `recommend_size` | — | `{brand}` → size to buy for the current estimate (rounds up) |

### `check_fit` / per-product verdicts

`POST /api/check-fit` (via the `check_fit` tool) does a `get_product`, infers the
numbering system from the run's shape (EU 34–49 vs US/UK 3–18), takes **gender
from the profile, never the catalog**, resolves against the profile's foot
length rounding up, and probes availability for the target size and its listed
neighbours.

Returns `{ verdict, recommendedLabel, sizeLengthMm, headroomMm, sentence, … }`
with `verdict` one of:

`fits` · `size_up` · `size_down` · `between_sizes` · `no_size` ·
`out_of_stock` · `unmapped_brand` · `unknown`

`exists:false` ("they don't make your size") is distinguished from
`available:false` ("your size is sold out") wherever the store exposes it. Kith
returns zero variants for both, so a listed-but-ungettable size reads as
`out_of_stock` there.

`search_catalog` attaches a lighter, labels-only verdict to every result (no
`get_product` per hit, so never `out_of_stock`) plus `scanned` / `matched`
counts — enough for "searched 40, 6 fit". Run `check_fit` on a specific product
for the stock-aware answer.

**The resolver is source-agnostic — UCP is one adapter.** `checkFit` only wants
the Size run and the profile; where the labels come from is the adapter's
problem. `check_fit` / `search_catalog` get them by negotiating a store and
reading its catalog. `check_labels` (`POST /api/check-labels`) gets them from the
caller — an agent already on the product page that read the `<select>` itself —
and never touches a store. Same verdict; no `out_of_stock` on that path, since
there's no stock data.

Every statement change re-runs `POST /api/estimate` (which calls
`size/estimateFootLength`), so the foot-length range and per-statement
resolution stay in sync. A conflict (statements more than a half-size apart)
shows as `conflict` with no best estimate — the panel says which reads longer.

## Typed shortcuts (no agent needed)

`Nike 9 fits` · `Birkenstock eu 42 fits` · `women` · `wide` · `reset`
