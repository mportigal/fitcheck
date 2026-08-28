import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA lives in app/. The API server (server/index.ts, port 8787) wraps the
// ucp/ and size/ modules; the browser only ever talks to it, never to Shopify.
export default defineConfig({
  root: "app",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "^/api/": "http://localhost:8787" },
  },
  preview: {
    port: 5173,
    proxy: { "^/api/": "http://localhost:8787" },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
