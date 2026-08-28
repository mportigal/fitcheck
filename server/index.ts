/**
 * server/index.ts — tiny JSON API in front of ucp/ and size/.
 *
 *   npm run dev:api        (port 8787; Vite proxies /api to it)
 *
 * Every route is POST with a JSON body. No framework — node:http is enough for
 * five endpoints.
 */

import { createServer } from "node:http";
import {
  routeNegotiate,
  routeSearch,
  routeEstimate,
  routeRecommend,
  routeCheckFit,
  toHttp,
} from "./routes.js";

const PORT = Number(process.env.PORT ?? 8787);

type Handler = (body: any) => unknown | Promise<unknown>;

const ROUTES: Record<string, Handler> = {
  "/api/negotiate": routeNegotiate,
  "/api/search": routeSearch,
  "/api/estimate": routeEstimate,
  "/api/recommend": routeRecommend,
  "/api/check-fit": routeCheckFit,
};

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "").split("?")[0];
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && url === "/api/health") {
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const handler = ROUTES[url];
  if (!handler || req.method !== "POST") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `no route for ${req.method} ${url}` }));
    return;
  }

  try {
    const body = await readBody(req);
    const result = await handler(body);
    res.end(JSON.stringify(result));
  } catch (err) {
    const { status, message } = toHttp(err);
    res.statusCode = status;
    res.end(JSON.stringify({ error: message }));
    if (status >= 500) console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`fitcheck api on http://localhost:${PORT}`);
});
