/**
 * app/store.ts — the fit profile, as one observable object.
 *
 * WebMCP tools (webmcp.ts) mutate it; the profile panel reads it through
 * useSyncExternalStore. Every statement change re-runs the server estimate so
 * the foot-length range stays in sync.
 */

import { estimate } from "./client";
import type { FitProfile, FitStatement, Gender, SizeSystem, Width } from "./types";

let profile: FitProfile = {
  gender: null,
  width: null,
  footLength: null,
  estimateStatus: "empty",
  statements: [],
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(next: FitProfile) {
  profile = next;
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getProfile(): FitProfile {
  return profile;
}

// ---- activity feed (drives the chat panel's system lines) ----------------

export interface Activity {
  id: string;
  at: number;
  kind: "user" | "tool" | "note";
  text: string;
  detail?: unknown;
}

const activityListeners = new Set<(a: Activity) => void>();

export function onActivity(fn: (a: Activity) => void): () => void {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

export function pushActivity(kind: Activity["kind"], text: string, detail?: unknown) {
  const a: Activity = { id: rid(), at: Date.now(), kind, text, detail };
  for (const l of activityListeners) l(a);
}

// ---- mutations ----------------------------------------------------------

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function patchProfile(fields: { gender?: Gender | null; width?: Width | null }) {
  set({
    ...profile,
    ...(fields.gender !== undefined ? { gender: fields.gender } : {}),
    ...(fields.width !== undefined ? { width: fields.width } : {}),
  });
}

export function addStatement(input: {
  brand: string;
  gender?: Gender;
  system?: SizeSystem;
  value: number;
}): FitStatement {
  const stmt: FitStatement = {
    id: rid(),
    brand: input.brand.trim(),
    gender: input.gender ?? profile.gender ?? "men",
    system: input.system ?? "us",
    value: input.value,
  };
  set({ ...profile, statements: [...profile.statements, stmt] });
  void recompute();
  return stmt;
}

export function removeStatement(id: string) {
  set({ ...profile, statements: profile.statements.filter((s) => s.id !== id) });
  void recompute();
}

export function setStatements(
  list: Array<{ brand: string; gender?: Gender; system?: SizeSystem; value: number }>,
) {
  set({
    ...profile,
    statements: list.map((s) => ({
      id: rid(),
      brand: s.brand.trim(),
      gender: s.gender ?? profile.gender ?? "men",
      system: s.system ?? "us",
      value: s.value,
    })),
  });
  void recompute();
}

export function resetProfile() {
  set({ gender: null, width: null, footLength: null, estimateStatus: "empty", statements: [] });
}

let recomputeSeq = 0;

/** Re-run the server estimate and fold the result back into the profile. */
export async function recompute(): Promise<void> {
  const seq = ++recomputeSeq;
  const current = profile.statements;

  if (current.length === 0) {
    set({ ...profile, footLength: null, estimateStatus: "empty" });
    return;
  }

  try {
    const res = await estimate(
      current.map((s) => ({ brand: s.brand, gender: s.gender, system: s.system, value: s.value })),
    );
    if (seq !== recomputeSeq) return; // superseded

    const byIndex = new Map(res.resolved.map((r) => [r.index, r]));
    const statements = profile.statements.map((s, i) => {
      const r = byIndex.get(i);
      return r
        ? { ...s, footLengthMm: r.footLengthMm, resolveStatus: r.status, note: r.note }
        : s;
    });

    set({
      ...profile,
      statements,
      estimateStatus: res.status,
      conflictNote: res.conflictNote,
      footLength:
        res.status === "ok" || res.status === "conflict"
          ? { low: res.low!, high: res.high!, bestMm: res.bestMm }
          : null,
    });
  } catch (err) {
    if (seq !== recomputeSeq) return;
    pushActivity("note", `estimate failed: ${(err as Error).message}`);
  }
}
