import { useSyncExternalStore } from "react";
import { getProfile, patchProfile, removeStatement, subscribe } from "../store";
import type { Gender, Width } from "../types";

const GENDERS: Gender[] = ["men", "women"];
const WIDTHS: Width[] = ["narrow", "standard", "wide"];

export function ProfilePanel() {
  const profile = useSyncExternalStore(subscribe, getProfile);
  const { footLength, estimateStatus, conflictNote, gender, width, statements } = profile;

  return (
    <aside className="panel">
      <h2>Foot length</h2>
      {footLength ? (
        <div className="field-value">
          {footLength.low}–{footLength.high} mm
          {footLength.bestMm != null && (
            <span className="field-value dim"> · best {footLength.bestMm} mm</span>
          )}
          <span className={`badge ${estimateStatus}`}>{estimateStatus}</span>
        </div>
      ) : (
        <div className="field-value dim">
          not estimated
          <span className={`badge ${estimateStatus}`}>{estimateStatus}</span>
        </div>
      )}
      {estimateStatus === "conflict" && conflictNote && (
        <div className="note-line">{conflictNote}</div>
      )}
      {estimateStatus === "unresolved" && (
        <div className="note-line">no fit statement resolved against a mapped brand</div>
      )}

      <h2>Gender</h2>
      <div className="toggle-row">
        {GENDERS.map((g) => (
          <button
            key={g}
            className={gender === g ? "selected" : ""}
            onClick={() => patchProfile({ gender: gender === g ? null : g })}
          >
            {g}
          </button>
        ))}
      </div>

      <h2>Width</h2>
      <div className="toggle-row">
        {WIDTHS.map((w) => (
          <button
            key={w}
            className={width === w ? "selected" : ""}
            onClick={() => patchProfile({ width: width === w ? null : w })}
          >
            {w}
          </button>
        ))}
      </div>

      <h2>Fit statements</h2>
      {statements.length === 0 ? (
        <div className="field-value dim">none yet</div>
      ) : (
        <ul className="statements">
          {statements.map((s) => (
            <li key={s.id}>
              <span className="grip">
                <span className="brand">{s.brand}</span> {s.system.toUpperCase()} {s.value}
                <span className="resolved">
                  {" — "}
                  {s.footLengthMm != null
                    ? `${s.footLengthMm} mm${s.resolveStatus ? ` (${s.resolveStatus})` : ""}`
                    : s.resolveStatus === "unknown"
                      ? "unmapped"
                      : "…"}
                </span>
              </span>
              <button
                className="remove"
                title="remove"
                aria-label={`remove ${s.brand} ${s.value}`}
                onClick={() => removeStatement(s.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tools-note">
        Panel is written by WebMCP tools: <code>update_fit_profile</code>,{" "}
        <code>add_fit_statement</code>, <code>remove_fit_statement</code>,{" "}
        <code>recommend_size</code>, <code>search_catalog</code>. Call them from an agent or{" "}
        <code>window.fitcheckMCP</code>.
      </div>
    </aside>
  );
}
