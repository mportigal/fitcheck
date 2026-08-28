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

import { checkFit, negotiate, recommend, search } from "./client";
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
  /** Does not mutate the profile or any server state. -> annotations.readOnlyHint */
  readOnly?: boolean;
  /** Return value contains catalog text authored by a third party (store/merchant).
   *  -> annotations.untrustedContentHint */
  untrustedContent?: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function annotationsFor(t: Tool): Record<string, boolean> {
  const a: Record<string, boolean> = {};
  if (t.readOnly) a.readOnlyHint = true;
  if (t.untrustedContent) a.untrustedContentHint = true;
  return a;
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

/** Foot length + gender the fit routes need, pulled from the current profile. */
function profileFit(): { footLengthMm: number | undefined; gender: Gender | null } {
  const p = getProfile();
  const mm =
    p.footLength?.bestMm ?? (p.footLength ? (p.footLength.low + p.footLength.high) / 2 : undefined);
  return { footLengthMm: mm, gender: p.gender };
}

const TOOLS: Tool[] = [
  {
    name: "get_fit_profile",
    readOnly: true,
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
    readOnly: true,
    untrustedContent: true,
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
      const { footLengthMm, gender } = profileFit();
      const res = await search(domain, query, footLengthMm != null ? { footLengthMm, gender } : undefined);
      if (footLengthMm != null) {
        pushActivity("note", `searched ${res.scanned}, ${res.matched} fit`);
      }
      return res;
    },
  },
  {
    name: "check_fit",
    readOnly: true,
    untrustedContent: true,
    description:
      "Check whether one product fits the current profile. Reads the full size matrix " +
      "(available/exists), infers the numbering system from the run's shape, and resolves against " +
      "the profile's foot length, rounding up. Gender comes from the profile, never the catalog.",
    inputSchema: {
      type: "object",
      required: ["store_domain", "product_id"],
      properties: {
        store_domain: { type: "string", description: "store hostname, e.g. kith.com" },
        product_id: { type: "string", description: "product id from search_catalog" },
      },
    },
    run: async (args) => {
      const domain = str(args.store_domain);
      const productId = str(args.product_id);
      if (!domain || !productId) throw new Error("store_domain and product_id are required");
      const { footLengthMm, gender } = profileFit();
      if (footLengthMm === undefined) {
        throw new Error("no foot-length estimate yet — add fit statements first");
      }
      const verdict = await checkFit(domain, productId, { footLengthMm, gender });
      pushActivity("note", `${verdict.verdict}: ${verdict.sentence}`);
      return verdict;
    },
  },
  {
    name: "negotiate_store",
    readOnly: true,
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
    readOnly: true,
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

interface ModelContext {
  registerTool?: (def: {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }) => void;
}

declare global {
  interface Window {
    fitcheckTools?: Record<string, (args?: Record<string, unknown>) => Promise<unknown> | unknown>;
    fitcheckMCP?: {
      listTools: () => Array<
        Pick<Tool, "name" | "description" | "inputSchema"> & { annotations: Record<string, boolean> }
      >;
      callTool: typeof callTool;
    };
  }
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
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
    listTools: () =>
      TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
        annotations: annotationsFor(TOOLS.find((t) => t.name === name)!),
      })),
    callTool,
  };

  // WebMCP moved the registry from navigator to document; support both.
  const mc: ModelContext | undefined = document.modelContext ?? navigator.modelContext;
  const where = document.modelContext ? "document.modelContext" : "navigator.modelContext";

  if (mc && typeof mc.registerTool === "function") {
    for (const t of TOOLS) {
      try {
        mc.registerTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: annotationsFor(t),
          execute: (args) => callTool(t.name, args ?? {}),
        });
      } catch (err) {
        console.warn(`${where}.registerTool failed for ${t.name}`, err);
      }
    }
    console.info(`fitcheck: registered ${TOOLS.length} tools via ${where}`);
  } else {
    console.info("fitcheck: no modelContext registry — tools available on window.fitcheckMCP");
  }
}
