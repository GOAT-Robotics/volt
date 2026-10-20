/**
 * What every MCP tool needs: the tool type, finding projects and versions by the names people
 * use, reading a version, and changing a working version the way the editor does (through the
 * live room when someone has it open, else saved with the optimistic revision check), with an
 * undo history per access token.
 */
import "server-only";
import { z } from "zod";
import { Immer } from "immer";
import { db, J } from "../db";
import { loadProject, type Ctx } from "../session";
import { assertEditable, docHash, loadVersion, parseDoc, scheduleReindex } from "../versioning";
import { audit } from "../audit";
import { liveHooks } from "../live/hooks";
import { projectScope } from "../access";
import { loadElement, assertMember } from "../library/access";
import { parseElmt } from "@/core/qet";
import { diffOps, applyOps, type LiveOp } from "@/core/live-ops";
import { statusLabel } from "../voltfile/types";
import type { Doc, ElementDef } from "@/core/model";
import type { TokenInfo } from "./tokens";
import { AddressError, findComponents } from "./doc";
import { EditError } from "./edits";

/** who is calling, through which token; `origin` = this server's address for links; `protocol` = the MCP version the client speaks */
export type Env = { ctx: Ctx; token: TokenInfo; origin?: string; protocol?: string };
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string; size?: number };
export type ToolResult = { content: Content[]; isError?: boolean };
export type Access = "read" | "comment" | "edit";
/** where a tool sits on the Connect page */
export type Area = "Projects & reading" | "Review" | "Components" | "Wires & cables" | "Terminals" | "Pages & annotations" | "Project settings" | "Library & blocks" | "History & workflow" | "Reports & files";
export type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  access: Access;
  area: Area;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: never, env: Env) => Promise<ToolResult | string>;
};

/** an error the assistant can act on (shown as the tool result, not as a protocol error) */
export class ToolError extends Error {}

export const immer = new Immer({ autoFreeze: false });
export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const via = (env: Env) => `mcp: ${env.token.name}`;
export const WORKING = ["DRAFT", "CHANGES_REQUESTED"];
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function tool<S extends z.ZodObject>(t: Omit<Tool, "input" | "run"> & { input: S; run: (args: z.infer<S>, env: Env) => Promise<ToolResult | string> }): Tool {
  return t as unknown as Tool;
}

/** AddressError / EditError (and plain Errors thrown by core edits) become messages the assistant can act on */
export const guard = <T,>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof AddressError || e instanceof EditError) throw new ToolError(e.message);
    throw e;
  }
};

/* ------------------------------------------------------------------ */
/* Shared argument schemas                                              */
/* ------------------------------------------------------------------ */

export const version = z.string().describe('The version: "DEMO-001" (the project\'s working version, else its newest), "DEMO-001@2" (version 2), or a version id');
export const page = z.coerce.string().describe('Page number in sheet order ("1"), page title, or page id');
export const component = z.string().describe('Component reference, e.g. "K1"; "K1@2" = the part of K1 on page 2; "#1a2b3c4d" = by id');
export const point = z.object({ x: z.number(), y: z.number() });
export const colour = z.string().max(40).describe('"#rrggbb" or a colour name');

/* ------------------------------------------------------------------ */
/* Finding projects and versions                                        */
/* ------------------------------------------------------------------ */

export async function findProject(ctx: Ctx, ref: string) {
  const s = ref.trim();
  if (!s) throw new ToolError("Give a project: its number, name or id");
  const scope = projectScope(ctx);
  const rows = await db.project.findMany({ where: { AND: [scope, { OR: [{ id: s }, { number: s }, { name: s }] }] }, take: 5 });
  const hit = rows.find((p) => p.id === s) ?? rows.find((p) => p.number === s) ?? (rows.length === 1 ? rows[0] : null);
  if (!hit) {
    if (rows.length > 1) throw new ToolError(`${rows.length} projects are called "${s}": ${rows.map((p) => `${p.number ?? "(no number)"} id ${p.id}`).join(", ")} — use the number or id`);
    const like = await db.project.findMany({ where: { AND: [scope, { OR: [{ name: { contains: s } }, { number: { contains: s } }] }] }, take: 8, select: { name: true, number: true } });
    throw new ToolError(`No project "${s}"${like.length ? `. Did you mean: ${like.map((p) => (p.number ? `${p.number} (${p.name})` : p.name)).join(", ")}` : " — use list_projects"}`);
  }
  return loadProject(ctx, hit.id);
}

/**
 * A version address: its id; "<project>@<label>" (e.g. DEMO-001@2, DEMO-001@2-ACME.1); or just the
 * project, meaning its main-line working version, else its newest main-line version.
 */
export async function resolveVersion(ctx: Ctx, ref: string): Promise<string> {
  const s = ref.trim();
  if (!s) throw new ToolError("Give a version, e.g. DEMO-001 (its working version) or DEMO-001@2");
  const direct = await db.version.findUnique({ where: { id: s }, select: { id: true } });
  if (direct) return direct.id;
  const at = s.lastIndexOf("@");
  const { project } = await findProject(ctx, at > 0 ? s.slice(0, at) : s);
  if (at > 0) {
    const label = s.slice(at + 1).replace(/^v/i, "");
    const v = await db.version.findFirst({ where: { projectId: project.id, label }, select: { id: true } });
    if (!v) {
      const labels = await db.version.findMany({ where: { projectId: project.id }, select: { label: true }, orderBy: { seq: "asc" } });
      throw new ToolError(`${project.name} has no version ${label} (versions: ${labels.map((x) => x.label).join(", ")})`);
    }
    return v.id;
  }
  const v =
    (await db.version.findFirst({ where: { projectId: project.id, variantId: null, status: { in: WORKING } }, orderBy: { seq: "desc" }, select: { id: true } })) ??
    (await db.version.findFirst({ where: { projectId: project.id, variantId: null }, orderBy: { seq: "desc" }, select: { id: true } })) ??
    (await db.version.findFirst({ where: { projectId: project.id }, orderBy: { seq: "desc" }, select: { id: true } }));
  if (!v) throw new ToolError(`${project.name} has no versions`);
  return v.id;
}

export async function readVersion(env: Env, ref: string) {
  const id = await resolveVersion(env.ctx, ref);
  const a = await loadVersion(env.ctx, id);
  return { a, doc: parseDoc(a.version.doc) };
}
export const vName = (a: { project: { name: string; number: string | null }; version: { label: string; status: string } }) =>
  `${a.project.number ? a.project.number + " " : ""}${a.project.name} v${a.version.label} (${statusLabel(a.version.status).toLowerCase()})`;

/** this token may change drawings at all (scope and workspace setting) */
export function assertCanEdit(env: Env, what = "change drawings") {
  if (env.token.scope !== "EDIT") throw new ToolError(`This access token is read-only — create one with edit access to ${what}`);
  if (!env.ctx.settings.mcp.allowEdits) throw new ToolError("Assistants may not edit drawings in this workspace (Administration → AI assistants)");
}

/* ------------------------------------------------------------------ */
/* Changing a drawing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Undo history of changes made through MCP, per version and access token: the inverse operations
 * of each change (id-addressed, so they stay correct when other people edit at the same time).
 * Kept in memory — a server restart forgets it (commits and restore_commit still work).
 */
type UndoEntry = { tokenId: string; tool: string; summary: string; inverse: LiveOp[]; at: number };
const g = globalThis as unknown as { __voltMcpUndo?: Map<string, UndoEntry[]> };
const undoLog: Map<string, UndoEntry[]> = (g.__voltMcpUndo ??= new Map());
const UNDO_LIMIT = 50;

export function undoEntries(versionId: string, tokenId: string) {
  return (undoLog.get(versionId) ?? []).filter((e) => e.tokenId === tokenId);
}
function popUndo(versionId: string, tokenId: string, n: number): UndoEntry[] {
  const list = undoLog.get(versionId) ?? [];
  const out: UndoEntry[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < n; i--) if (list[i].tokenId === tokenId) out.push(...list.splice(i, 1));
  return out;
}

/**
 * Apply a change to a working version. With the version open in a live editor, the change goes
 * through the live room (everyone sees it at once); otherwise it is saved like an editor save.
 * `change` mutates the draft and returns a report for the assistant.
 */
export async function editDrawing(env: Env, ref: string, tool: string, change: (d: Doc) => string, opts: { undo?: boolean } = {}): Promise<string> {
  assertCanEdit(env);
  const id = await resolveVersion(env.ctx, ref);
  const a = await loadVersion(env.ctx, id, { withDoc: false });
  try {
    assertEditable(a);
  } catch {
    const hint = WORKING.includes(a.version.status) ? "" : " Use start_new_version to make a new draft.";
    throw new ToolError(`${vName(a)} cannot be changed: ${(a.reason ?? "not a working version").replace(/ — start a new version to make changes\.?$/, "")}.${hint}`);
  }
  let summary = "";
  let inverse: LiveOp[] = [];
  const run = (base: Doc) => {
    const next = immer.produce(base, (d: Doc) => {
      summary = change(d);
    });
    inverse = next === base ? [] : diffOps(next, base);
    return next;
  };
  const by = { userId: env.ctx.user.id, name: `${env.ctx.user.name} (via ${env.token.name})` };
  const live = liveHooks.edit?.(id, by, run);
  if (!live) {
    for (let attempt = 0; ; attempt++) {
      const row = await db.version.findUnique({ where: { id }, select: { doc: true, docRev: true } });
      if (!row) throw new ToolError("Version not found");
      const base = parseDoc(row.doc);
      const next = run(base);
      if (next === base) break;
      const res = await db.version.updateMany({ where: { id, docRev: row.docRev, status: { in: WORKING } }, data: { doc: JSON.stringify(next), docRev: { increment: 1 }, docHash: docHash(next) } });
      if (res.count) {
        scheduleReindex(id, a.project.id, next);
        break;
      }
      if (attempt >= 2) throw new ToolError("The version was being saved at the same time — try again");
    }
  }
  const changed = inverse.length > 0;
  if (changed && opts.undo !== false) {
    const list = undoLog.get(id) ?? [];
    list.push({ tokenId: env.token.id, tool, summary: summary.split("\n")[0].slice(0, 160), inverse, at: Date.now() });
    while (list.filter((e) => e.tokenId === env.token.id).length > UNDO_LIMIT) list.splice(list.findIndex((e) => e.tokenId === env.token.id), 1);
    undoLog.set(id, list);
  }
  if (changed) {
    await db.project.update({ where: { id: a.project.id }, data: { updatedAt: new Date() } }).catch(() => {});
    await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: env.ctx.user.id, type: "mcp.edit", data: { tool, label: a.version.label, summary: summary.slice(0, 500), token: env.token.name, live: !!live } });
  }
  if (!changed) return `${summary}\n(Nothing changed in ${vName(a)}.)`;
  return `${summary}\n(${vName(a)} — saved${live ? ", shown live to everyone who has it open" : ""}. Undo with undo; record a commit with commit_changes when a set of changes is done.)`;
}

/** undo the last `steps` changes this token made to a version */
export async function undoChanges(env: Env, ref: string, steps: number): Promise<string> {
  assertCanEdit(env);
  const id = await resolveVersion(env.ctx, ref);
  const entries = popUndo(id, env.token.id, steps);
  if (!entries.length) return "Nothing to undo: this access token made no changes to that version since the server started (use compare_versions / restore_commit for older changes)";
  try {
    return await editDrawing(
      env,
      id,
      "undo",
      (d) => {
        for (const e of entries) applyOps(d, e.inverse);
        return `Undid ${plural(entries.length, "change")}: ${entries.map((e) => `${e.tool} (${e.summary})`).join("; ")}`;
      },
      { undo: false },
    );
  } catch (e) {
    // put them back when the version could not be changed
    const list = undoLog.get(id) ?? [];
    list.push(...entries.reverse());
    undoLog.set(id, list);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Symbols                                                              */
/* ------------------------------------------------------------------ */

/** a library element (symbol) as a project definition, at the revision the person may see */
export async function libraryDef(env: Env, libraryId: string): Promise<ElementDef> {
  assertMember(env.ctx);
  const acc = await loadElement(env.ctx, libraryId).catch(() => null);
  if (!acc) throw new ToolError(`No library element ${libraryId} — use search_library`);
  if (acc.el.kind !== "ELEMENT") throw new ToolError("That library item is a block, not a single symbol — use place_block");
  let content = acc.el.content;
  let rev = acc.el.revision;
  let meta = acc.el.meta;
  if (acc.viewerRevision !== acc.el.revision) {
    const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: acc.el.id, revision: acc.viewerRevision } } });
    if (r) ((content = r.content), (rev = r.revision), (meta = r.meta || meta));
  }
  const id = `lib:${acc.el.id}@${rev}`;
  const def = parseElmt(content, { id, category: acc.el.category });
  def.id = id;
  def.source = { libraryElementId: acc.el.id, revision: rev, status: acc.el.status };
  if (acc.el.prefix && !def.prefix) def.prefix = acc.el.prefix;
  def.meta = { ...def.meta, ...Object.fromEntries(Object.entries(J.parse<Record<string, unknown>>(meta, {})).filter(([k, v]) => !k.startsWith("__") && typeof v === "string")) } as Record<string, string>;
  return def;
}

/** a symbol to place: a library element, the symbol of a component already in the drawing, or a symbol name in the drawing */
export async function symbolFor(env: Env, doc: Doc, s: { library_id?: string; like?: string; symbol?: string }): Promise<ElementDef> {
  if (s.library_id) {
    const def = await libraryDef(env, s.library_id);
    return doc.defs[def.id] ?? def;
  }
  if (s.like) return guard(() => findComponents(doc, s.like!))[0].def ?? (() => { throw new ToolError(`${s.like} has no symbol`); })();
  if (s.symbol) {
    const q = s.symbol.trim().toLowerCase();
    const defs = Object.values(doc.defs).filter((d) => d.name !== "volt_junction");
    const hit = defs.filter((d) => d.name.toLowerCase() === q || Object.values(d.names ?? {}).some((n) => n.toLowerCase() === q));
    if (hit.length) return hit[0];
    throw new ToolError(`No symbol "${s.symbol}" in this drawing (symbols used: ${[...new Set(defs.map((d) => d.name))].slice(0, 40).join(", ")}). Use library_id from search_library, or like: <reference of a component with that symbol>`);
  }
  throw new ToolError("Say which symbol: library_id (from search_library), like (copy the symbol of a component, e.g. K1) or symbol (a symbol name already in the drawing)");
}
