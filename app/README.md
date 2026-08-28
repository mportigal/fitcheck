# app/ — the Fit Check page

One page: a chat column on the left, the fit profile panel on the right. An
agent drives it over WebMCP; the panel re-renders whenever a tool writes to the
store.

```
npm run dev        # api (8787) + vite (5173) together
npm run build      # -> dist/
npm run typecheck  # node code + app code
```

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

Registered on `navigator.modelContext` when the browser supports it, and always
on `window.fitcheckMCP` (`.listTools()`, `.callTool(name, args)`) and
`window.fitcheckTools[name](args)` for console / test use.

| tool | writes | notes |
|---|---|---|
| `get_fit_profile` | — | current profile |
| `update_fit_profile` | gender, width, statements | `statements` replaces the list; `null` clears a field |
| `add_fit_statement` | one statement | `{brand, value, gender?, system?}`; defaults men / us |
| `remove_fit_statement` | — | by `id` |
| `reset_fit_profile` | — | clear everything |
| `search_catalog` | — | `{domain, query}` → server → ucp/ |
| `negotiate_store` | — | `{domain}` → server → ucp/ |
| `recommend_size` | — | `{brand}` → size to buy for the current estimate (rounds up) |

Every statement change re-runs `POST /api/estimate` (which calls
`size/estimateFootLength`), so the foot-length range and per-statement
resolution stay in sync. A conflict (statements more than a half-size apart)
shows as `conflict` with no best estimate — the panel says which reads longer.

## Typed shortcuts (no agent needed)

`Nike 9 fits` · `Birkenstock eu 42 fits` · `women` · `wide` · `reset`
