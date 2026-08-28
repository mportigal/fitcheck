/**
 * api/[...slug].ts — Vercel serverless entry.
 *
 * One catch-all function behind /api/*, dispatching to the same route bodies
 * server/index.ts uses locally. Local dev still runs server/index.ts on 8787;
 * this file is only exercised on Vercel.
 */

import {
  routeNegotiate,
  routeSearch,
  routeEstimate,
  routeRecommend,
  routeCheckFit,
  toHttp,
} from "../server/routes.js";

// Minimal shape of what Vercel's Node runtime passes. Avoids a dependency on
// @vercel/node just for two type aliases.
interface VercelRequest {
  method?: string;
  url?: string;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

const ROUTES: Record<string, (body: any) => unknown | Promise<unknown>> = {
  negotiate: routeNegotiate,
  search: routeSearch,
  estimate: routeEstimate,
  recommend: routeRecommend,
  "check-fit": routeCheckFit,
};

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Derive the route from the URL path — robust regardless of how the platform
  // parses the [...slug] dynamic segment.
  const fromUrl = (req.url ?? "").split("?")[0].replace(/^\/+api\/+/, "").replace(/\/+$/, "");
  const rawSlug = req.query.slug;
  const fromQuery = Array.isArray(rawSlug) ? rawSlug.join("/") : (rawSlug ?? "");
  const slug = fromUrl || fromQuery;

  if (req.method === "GET" && slug === "health") {
    res.status(200).json({ ok: true });
    return;
  }

  const route = ROUTES[slug];
  if (!route || req.method !== "POST") {
    res.status(404).json({ error: `no route for ${req.method} /api/${slug}` });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    res.status(200).json(await route(body));
  } catch (err) {
    const { status, message } = toHttp(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  }
}
