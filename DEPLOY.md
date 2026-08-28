# Deploying to Vercel

The Vite app builds to `dist/` (static); `server/routes.ts` runs as one
serverless function behind `/api/*` via [`api/[...slug].ts`](api/%5B...slug%5D.ts).
Local dev is unchanged — `npm run dev` still runs `server/index.ts` on 8787 and
Vite proxies to it.

## Config already in the repo

- **[`vercel.json`](vercel.json)** — `vite build` → `dist/`; `api/**` functions
  get `size/*.csv` bundled (`includeFiles`) and a 30s `maxDuration`.
- **[`api/[...slug].ts`](api/%5B...slug%5D.ts)** — catch-all dispatching to the
  same route bodies as local dev.
- **`engines.node >= 20`** in `package.json`.

No environment variables are required. `UCP_PLATFORM_PROFILE_URL` defaults to the
jsDelivr copy of `ucp/platform-profile.json`; set it in Vercel only if you later
host the profile somewhere else.

## What to do in the browser

1. Go to **vercel.com** and sign in with the **GitHub** account that owns
   `mportigal/fitcheck`.
2. **Add New… → Project**, then **Import** `mportigal/fitcheck`.
3. On the configure screen:
   - **Framework Preset**: Vite (it'll auto-detect; `vercel.json` overrides the
     details anyway).
   - **Root Directory**: leave as `./`.
   - **Build & Output**: leave the defaults — `vercel.json` supplies
     `vite build` and `dist`.
   - **Environment Variables**: none.
4. Click **Deploy** and wait for the build.
5. When it's live, check:
   - `https://<project>.vercel.app` — the page loads, chat left / panel right.
   - `https://<project>.vercel.app/api/health` — returns `{"ok":true}`.
   - In the page, run a `search_catalog` (type `Nike 9 fits` then, from an agent
     or the console, `window.fitcheckMCP.callTool("search_catalog", {domain:"kith.com", query:"nike"})`).
6. Every push to `main` redeploys automatically. Pull requests get preview URLs.

## If `/api/*` returns 500

Open the deployment in the Vercel dashboard → **Functions** → view logs.

- `ENOENT ... sizely-shoe-sample.csv` — the `includeFiles` glob didn't match.
  Confirm `vercel.json` has `"includeFiles": "size/*.csv"` and redeploy.
  `loadDefaultSizeTable` also falls back to `process.cwd()/size/…`, which is
  where `includeFiles` puts it.
- A timeout on `/api/search` or `/api/check-fit` — the store's UCP endpoint was
  slow. `maxDuration` is 30s; retry.
