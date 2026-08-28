import { useEffect, useRef, useState } from "react";
import { onActivity, pushActivity, type Activity } from "../store";

/**
 * The left column. An external agent drives the WebMCP tools and its calls show
 * up here as they land. With no agent connected, a few typed shortcuts stand in
 * so the page demos on its own.
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
            <p>
              An agent connected over WebMCP calls the fit tools and its activity shows here.
            </p>
            <p>
              Without one, type a shortcut: <code>Nike 9 fits</code>, <code>Birkenstock eu 42 fits</code>,{" "}
              <code>women</code>, <code>wide</code>, <code>reset</code>.
            </p>
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className={`msg ${e.kind}`}>
            <div className="who">
              {e.kind === "user" ? "you" : e.kind === "tool" ? "tool" : "note"} ·{" "}
              {new Date(e.at).toLocaleTimeString()}
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
          placeholder='"Nike 9 fits"  ·  "women"  ·  "reset"'
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

const FITS = /^(.+?)\s+(?:(us|uk|eu)\s*)?(\d+(?:\.\d+)?)\s+fits\.?$/i;
const GENDER = /^(men|women)$/i;
const WIDTH = /^(narrow|standard|wide)$/i;
const RESET = /^(reset|clear)$/i;

async function interpret(text: string): Promise<void> {
  const mcp = window.fitcheckMCP;
  if (!mcp) {
    pushActivity("note", "WebMCP tools not installed");
    return;
  }

  let m: RegExpExecArray | null;
  if (RESET.test(text)) {
    await mcp.callTool("reset_fit_profile", {});
  } else if ((m = GENDER.exec(text))) {
    await mcp.callTool("update_fit_profile", { gender: m[1].toLowerCase() });
  } else if ((m = WIDTH.exec(text))) {
    await mcp.callTool("update_fit_profile", { width: m[1].toLowerCase() });
  } else if ((m = FITS.exec(text))) {
    await mcp.callTool("add_fit_statement", {
      brand: m[1].trim(),
      system: m[2]?.toLowerCase(),
      value: Number(m[3]),
    });
  } else {
    pushActivity(
      "note",
      'not understood — try "Nike 9 fits", "women", "wide", "reset", or connect an agent via WebMCP',
    );
  }
}
