import { useEffect, useRef, useState } from "react";
import { onActivity, pushActivity, type Activity } from "../store";
import type {
  CatalogProduct,
  CheckFitResponse,
  CheckLabelsResponse,
  RecommendResponse,
} from "../types";

/**
 * The left column. An external agent drives the WebMCP tools and its calls show
 * up here as they land. With no agent connected, a few typed shortcuts stand in
 * so the page demos on its own — including the catalog tools, so the whole
 * search -> check -> recommend flow is watchable without DevTools.
 */
export function ChatPanel() {
  const [entries, setEntries] = useState<Activity[]>([]);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => onActivity((a) => setEntries((e) => [...e, a])), []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    pushActivity("user", text);
    void interpret(text);
  }

  return (
    <section className="chat">
      <div className="transcript">
        {entries.length === 0 && (
          <div className="empty">
            <p>An agent connected over WebMCP calls the fit tools and its activity shows here.</p>
            <p>Without one, type a shortcut:</p>
            <p>
              <code>Nike 9 fits</code> · <code>Birkenstock eu 42 fits</code> · <code>women</code> ·{" "}
              <code>wide</code> · <code>reset</code>
              <br />
              <code>search kith.com sneakers</code> · <code>check 2</code> ·{" "}
              <code>check labels nike 7,8,9,10</code> · <code>recommend Nike</code>
            </p>
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className={`msg ${e.kind}`}>
            <div className="who">
              {label(e.kind)} · {new Date(e.at).toLocaleTimeString()}
            </div>
            <div className="body">{e.text}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder='"Nike 9 fits" · "search kith.com sneakers" · "check 2" · "check labels nike 7,8,9,10" · "recommend Nike"'
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send}>Send</button>
      </div>
    </section>
  );
}

function label(kind: Activity["kind"]): string {
  return kind === "user" ? "you" : kind === "tool" ? "tool" : kind === "result" ? "result" : "note";
}

// -------------------------------------------------------------- shortcuts

const FITS = /^(.+?)\s+(?:(us|uk|eu)\s*)?(\d+(?:\.\d+)?)\s+fits\.?$/i;
const GENDER = /^(men|women)$/i;
const WIDTH = /^(narrow|standard|wide)$/i;
const RESET = /^(reset|clear)$/i;
const SEARCH = /^search\s+(\S+)\s+(.+)$/i;
const CHECK_LABELS = /^check\s+labels\s+(.+)$/i;
const CHECK = /^check\s+(\d+)$/i;
const RECOMMEND = /^recommend\s+(.+)$/i;

/** The last `search` result, so `check <n>` can refer to it. */
let lastSearch: { domain: string; products: CatalogProduct[] } | null = null;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const mcp = window.fitcheckMCP;
  if (!mcp) return null;
  const res = await mcp.callTool(name, args);
  const text = res.content?.[0]?.text ?? "{}";
  const data = JSON.parse(text);
  if ((res as { isError?: boolean }).isError) return null; // callTool already pushed the failure note
  return data as T;
}

async function interpret(text: string): Promise<void> {
  if (!window.fitcheckMCP) {
    pushActivity("note", "WebMCP tools not installed");
    return;
  }

  let m: RegExpExecArray | null;

  if (RESET.test(text)) {
    await call("reset_fit_profile", {});
  } else if ((m = GENDER.exec(text))) {
    await call("update_fit_profile", { gender: m[1].toLowerCase() });
  } else if ((m = WIDTH.exec(text))) {
    await call("update_fit_profile", { width: m[1].toLowerCase() });
  } else if ((m = SEARCH.exec(text))) {
    await runSearch(m[1], m[2].trim());
  } else if ((m = CHECK_LABELS.exec(text))) {
    await runCheckLabels(m[1]);
  } else if ((m = CHECK.exec(text))) {
    await runCheck(Number(m[1]));
  } else if ((m = RECOMMEND.exec(text))) {
    await runRecommend(m[1].trim());
  } else if ((m = FITS.exec(text))) {
    await call("add_fit_statement", {
      brand: m[1].trim(),
      system: m[2]?.toLowerCase(),
      value: Number(m[3]),
    });
  } else {
    pushActivity(
      "note",
      'not understood — try "Nike 9 fits", "search kith.com sneakers", "check 2", ' +
        '"check labels nike 7,8,9,10", "recommend Nike", "reset"',
    );
  }
}

async function runCheckLabels(rest: string): Promise<void> {
  // "<brand words> <comma,joined,sizes>" — the labels are the trailing run of
  // words that carry a digit or comma; everything before them is the brand.
  const words = rest.trim().split(/\s+/);
  let cut = words.length;
  while (cut > 0 && /[\d,]/.test(words[cut - 1])) cut--;
  const brand = words.slice(0, cut).join(" ");
  const labels = words.slice(cut).join("").split(",").map((s) => s.trim()).filter(Boolean);

  if (!brand || labels.length === 0) {
    pushActivity("note", 'usage: check labels <brand> <comma,separated,sizes> — e.g. "check labels new balance 7,8,9,10"');
    return;
  }

  const v = await call<CheckLabelsResponse>("check_labels", { brand, labels });
  if (!v) return;
  pushActivity(
    "result",
    `check labels — ${brand}  ·  [${labels.join(", ")}]\n` +
      `${v.recommendedLabel ?? "—"} · ${v.verdict}\n${v.sentence}`,
  );
}

async function runSearch(domain: string, query: string): Promise<void> {
  const data = await call<{
    scanned: number;
    matched: number;
    products: CatalogProduct[];
  }>("search_catalog", { domain, query });
  if (!data) return;

  lastSearch = { domain, products: data.products };

  const lines = data.products.map((p, i) => {
    const f = p.fit;
    const size = f?.recommendedLabel ? ` · ${f.recommendedLabel}` : "";
    const verdict = f ? ` · ${f.verdict}` : "";
    const head = `${String(i + 1).padStart(2)}. ${p.title}  ·  ${p.brand || "?"}${size}${verdict}`;
    return f?.sentence ? `${head}\n    ${f.sentence}` : head;
  });

  pushActivity(
    "result",
    `${domain} "${query}" — searched ${data.scanned}, ${data.matched} fit\n` +
      (lines.join("\n") || "(no products)") +
      `\n\n"check <n>" for the stock-aware verdict on one of these.`,
  );
}

async function runCheck(n: number): Promise<void> {
  if (!lastSearch) {
    pushActivity("note", 'nothing to check — run "search <domain> <query>" first');
    return;
  }
  const product = lastSearch.products[n - 1];
  if (!product) {
    pushActivity("note", `no result #${n} — last search returned ${lastSearch.products.length}`);
    return;
  }

  const v = await call<CheckFitResponse>("check_fit", {
    domain: lastSearch.domain,
    product_id: product.id,
  });
  if (!v) return;

  pushActivity(
    "result",
    `check ${n} — ${v.title}  ·  ${v.brand || "?"}\n` +
      `${v.recommendedLabel ?? "—"} · ${v.verdict}\n${v.sentence}`,
  );
}

async function runRecommend(brand: string): Promise<void> {
  const r = await call<RecommendResponse>("recommend_size", { brand });
  if (!r) return;

  if (r.status === "unknown") {
    pushActivity("result", `recommend ${brand} — unknown\n${r.reason ?? "no size mapping"}`);
    return;
  }
  pushActivity(
    "result",
    `recommend ${brand} — ${r.label ?? `US ${r.us}`}\n` +
      `US ${r.us ?? "?"} / UK ${r.uk ?? "?"} / EU ${r.eu ?? "?"} · ${r.status}`,
  );
}
