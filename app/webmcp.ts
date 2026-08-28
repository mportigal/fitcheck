/**
 * app/webmcp.ts — the page's WebMCP tool surface.
 *
 * An external agent (e.g. Claude in the browser) calls these tools; each one
 * writes to the fit-profile store, so the panel updates live. The tools are
 * also exposed on `window.fitcheckTools` / `window.fitcheckMCP` so they can be
 * driven from the console or a test without an agent present.
 *
 * If the browser implements the W3C Web Model Context proposal
 * (`navigator.modelContext.registerTool`) the tools are registered there too.
 */

import { negotiate, recommend, search } from "./client";
import {
  addStatement,
  getProfile,
  patchProfile,
  pushActivity,
  removeStatement,
  resetProfile,
  setStatements,
} from "./store";
import type { Gender, SizeSystem, Width } from "./types";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const asGender = (v: unknown): Gender | undefined => (v === "men" || v === "women" ? v : undefined);
const asSystem = (v: unknown): SizeSystem | undefined =>
  v === "us" || v === "uk" || v === "eu" ? v : undefined;
const asWidth = (v: unknown): Width | undefined =>
  v === "narrow" || v === "standard" || v === "wide" ? v : undefined;

const TOOLS: Tool[] = [
  {
    name: "get_fit_profile",
    description: "Return the current fit profile: gender, width, foot-length range, and fit statements.",
    inputSchema: { type: "object", properties: {} },
    run: () => getProfile(),
  },
  {
    name: "update_fit_profile",
    description:
      "Update the fit profile. Any field may be set. `statements` replaces the whole list; " +
      "use add_fit_statement to append one. Setting a field to null clears it.",
    inputSchema: {
      type: "object",
      properties: {
        gender: { type: ["string", "null"], enum: ["men", "women", null] },
        width: { type: ["string", "null"], enum: ["narrow", "standard", "wide", null] },
        statements: {
          type: "array",
          items: {
            type: "object",
            required: ["brand", "value"],
            properties: {
              brand: { type: "string" },
              gender: { type: "string", enum: ["men", "women"] },
              system: { type: "string", enum: ["us", "uk", "eu"] },
              value: { type: "number" },
            },
          },
        },
      },
    },
    run: (args) => {
      const patch: { gender?: Gender | null; width?: Width | null } = {};
      if ("gender" in args) patch.gender = args.gender === null ? null : asGender(args.gender) ?? null;
      if ("width" in args) patch.width = args.width === null ? null : asWidth(args.width) ?? null;
      if (Object.keys(patch).length) patchProfile(patch);

      if (Array.isArray(args.statements)) {
        const list = args.statements
          .map((s) => {
            const o = s as Record<string, unknown>;
            const brand = str(o.brand);
            const value = num(o.value);
            if (!brand || value === undefined) return null;
            return { brand, value, gender: asGender(o.gender), system: asSystem(o.system) };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null);
        setStatements(list);
      }
      return getProfile();
    },
  },
  {
    name: "add_fit_statement",
    description:
      "Append one 'this size fits me' statement, e.g. {brand:'Nike', value:9}. gender defaults " +
      "to the profile's gender (or men); system defaults to us.",
    inputSchema: {
      type: "object",
      required: ["brand", "value"],
      properties: {
        brand: { type: "string" },
        value: { type: "number" },
        gender: { type: "string", enum: ["men", "women"] },
        system: { type: "string", enum: ["us", "uk", "eu"] },
      },
    },
    run: (args) => {
      const brand = str(args.brand);
      const value = num(args.value);
      if (!brand || value === undefined) throw new Error("brand and numeric value are required");
      const stmt = addStatement({ brand, value, gender: asGender(args.gender), system: asSystem(args.system) });
      return { added: stmt, profile: getProfile() };
    },
  },
  {
    name: "remove_fit_statement",
    description: "Remove a fit statement by its id (from get_fit_profile).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    run: (args) => {
      const id = str(args.id);
      if (!id) throw new Error("id is required");
      removeStatement(id);
      return getProfile();
    },
  },
  {
    name: "reset_fit_profile",
    description: "Clear the whole fit profile.",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      resetProfile();
      return getProfile();
    },
  },
  {
    name: "search_catalog",
    description:
      "Search a store's catalog through the UCP layer (server-side). Returns products with their " +
      "Size option labels. The browser never calls Shopify directly.",
    inputSchema: {
      type: "object",
      required: ["domain", "query"],
      properties: {
        domain: { type: "string", description: "store hostname, e.g. kith.com" },
        query: { type: "string" },
      },
    },
    run: async (args) => {
      const domain = str(args.domain);
      const query = str(args.query);
      if (!domain || !query) throw new Error("domain and query are required");
      return search(domain, query);
    },
  },
  {
    name: "negotiate_store",
    description: "Run UCP discovery + capability negotiation for a store (server-side).",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: { domain: { type: "string" } },
    },
    run: async (args) => {
      const domain = str(args.domain);
      if (!domain) throw new Error("domain is required");
      return negotiate(domain);
    },
  },
  {
    name: "recommend_size",
    description:
      "Given a brand, recommend the size to buy for the current foot-length estimate (rounds up). " +
      "Needs a resolved foot-length range in the profile first.",
    inputSchema: {
      type: "object",
      required: ["brand"],
      properties: {
        brand: { type: "string" },
        gender: { type: "string", enum: ["men", "women"] },
      },
    },
    run: async (args) => {
      const brand = str(args.brand);
      if (!brand) throw new Error("brand is required");
      const p = getProfile();
      const mm = p.footLength?.bestMm ?? (p.footLength ? (p.footLength.low + p.footLength.high) / 2 : undefined);
      if (mm === undefined) throw new Error("no foot-length estimate yet — add fit statements first");
      const gender = asGender(args.gender) ?? p.gender ?? "men";
      return recommend(brand, gender, mm);
    },
  },
];

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  pushActivity("tool", `${name}(${summarize(args)})`, args);
  try {
    const result = await tool.run(args);
    window.dispatchEvent(new CustomEvent("fitcheck:tool", { detail: { name, args, result } }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = (err as Error).message;
    pushActivity("note", `${name} failed: ${message}`);
    return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
  }
}

function summarize(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const s = parts.join(", ");
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

declare global {
  interface Window {
    fitcheckTools?: Record<string, (args?: Record<string, unknown>) => Promise<unknown> | unknown>;
    fitcheckMCP?: {
      listTools: () => Array<Pick<Tool, "name" | "description" | "inputSchema">>;
      callTool: typeof callTool;
    };
  }
  interface Navigator {
    modelContext?: {
      registerTool?: (def: {
        name: string;
        description: string;
        inputSchema: unknown;
        execute: (args: Record<string, unknown>) => Promise<unknown>;
      }) => void;
    };
  }
}

let installed = false;

export function installWebMCP(): void {
  if (installed) return;
  installed = true;

  window.fitcheckTools = Object.fromEntries(
    TOOLS.map((t) => [t.name, (args: Record<string, unknown> = {}) => t.run(args)]),
  );
  window.fitcheckMCP = {
    listTools: () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    callTool,
  };

  const mc = navigator.modelContext;
  if (mc && typeof mc.registerTool === "function") {
    for (const t of TOOLS) {
      try {
        mc.registerTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          execute: (args) => callTool(t.name, args ?? {}),
        });
      } catch (err) {
        console.warn(`navigator.modelContext.registerTool failed for ${t.name}`, err);
      }
    }
    console.info("fitcheck: registered", TOOLS.length, "tools via navigator.modelContext");
  } else {
    console.info(
      "fitcheck: navigator.modelContext not present — tools available on window.fitcheckMCP",
    );
  }
}
