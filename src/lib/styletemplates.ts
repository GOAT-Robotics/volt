import { J } from "./db";
import { defaultStyles, deepMerge } from "@/core/styles";
import type { Styles } from "@/core/model";

export type HistoryEntry = { version: number; action: "create" | "edit" | "approve" | "default" | "retire" | "copy"; at: string; by: string; note?: string; styles?: unknown; content?: unknown; name?: string };

export function parseHistory(s: string | null | undefined): HistoryEntry[] {
  return J.parse<HistoryEntry[]>(s, []);
}

export function pushHistory(s: string | null | undefined, e: HistoryEntry): string {
  const h = parseHistory(s);
  h.push(e);
  return JSON.stringify(h.slice(-50));
}

/** Full Styles object (missing keys filled from the built-in defaults). */
export function normalizeStyles(v: unknown): Styles {
  return deepMerge(defaultStyles(), (v ?? {}) as never);
}

/**
 * Styles usable for new documents: the current styles if the template is APPROVED, else the last
 * approved snapshot from its history (so editing a default template never silently changes new projects).
 */
export function approvedStyles(t: { status: string; styles: string; history: string; version: number }): { styles: Styles; version: number } | null {
  if (t.status === "APPROVED") return { styles: normalizeStyles(J.parse(t.styles, {})), version: t.version };
  const h = parseHistory(t.history).filter((e) => e.action === "approve" && e.styles);
  const last = h[h.length - 1];
  return last ? { styles: normalizeStyles(last.styles), version: last.version } : null;
}
