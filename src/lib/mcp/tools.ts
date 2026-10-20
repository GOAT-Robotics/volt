/**
 * The tools the Volt MCP server offers. Every tool runs as the person who owns the access token,
 * with their workspace roles and projects (loadProject / loadVersion), and drawing edits follow
 * the same rules as the editor: only working drafts, only with the Edit role, live to everyone who
 * has the version open, recorded in the audit log as made via MCP.
 */
import "server-only";
import { z } from "zod";
import { Immer } from "immer";
import { db, J } from "../db";
import { HttpError, loadProject, type Ctx } from "../session";
import { assertEditable, docHash, loadVersion, parseDoc, scheduleReindex } from "../versioning";
import { audit } from "../audit";
import { liveHooks, flushLive } from "../live/hooks";
import { createCommit } from "../commits";
import { startVersion } from "../versions";
import { addComment, setCommentStatus } from "../comment-actions";
import { projectScope } from "../access";
import { loadElement, visibleWhere, assertMember, writableLibrary } from "../library/access";
import { aiSymbolToDef, type AiSymbol } from "../library/ai-symbol";
import { createElementRecord, addRevision } from "../library/store";
import { newUuid, normCategory, guessPrefix } from "../library/elmt-tools";
import { elementSvg } from "../library/preview";
import { serializeElmt } from "@/core/qet/elmt";
import { svgToPng } from "../og/raster";
import { approxMeasure, pageToSvg } from "@/core/render/svg";
import { parseElmt } from "@/core/qet";
import { statusLabel } from "../voltfile/types";
import type { Doc, ElementDef } from "@/core/model";
import type { TokenInfo } from "./tokens";
import { withLinkedParts, AddressError, checksText, componentText, componentsText, findComponent, findComponents, findPage, findWires, netlistText, overviewText, positionOf, sheetNo, sheets, short, wiresText } from "./doc";
import { applyReferences, connectPins, deleteComponent, deleteWires, EditError, moveComponent, numberWires, placeComponent, planReferences, refChangesText, renameComponent, setComponentData, setWires, type InfoField } from "./edits";

export type Env = { ctx: Ctx; token: TokenInfo };
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };
type Access = "read" | "comment" | "edit";
export type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  access: Access;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: never, env: Env) => Promise<ToolResult | string>;
};

/** an error the assistant can act on (shown as the tool result, not as a protocol error) */
export class ToolError extends Error {}

const immer = new Immer({ autoFreeze: false });
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const via = (env: Env) => `mcp: ${env.token.name}`;
const WORKING = ["DRAFT", "CHANGES_REQUESTED"];

/* ------------------------------------------------------------------ */
/* Finding projects and versions                                        */
/* ------------------------------------------------------------------ */

async function findProject(ctx: Ctx, ref: string) {
  const s = ref.trim();
  if (!s) throw new ToolError("Give a project: its number, name or id");
  const scope = projectScope(ctx);
  const rows = await db.project.findMany({ where: { AND: [scope, { OR: [{ id: s }, { number: s }, { name: s }] }] }, take: 5 });
  const hit = rows.find((p) => p.id === s) ?? rows.find((p) => p.number === s) ?? (rows.length === 1 ? rows[0] : null);
  if (!hit) {
    const like = await db.project.findMany({ where: { AND: [scope, { OR: [{ name: { contains: s } }, { number: { contains: s } }] }] }, take: 8, select: { name: true, number: true } });
    throw new ToolError(`No project "${s}"${like.length ? `. Did you mean: ${like.map((p) => (p.number ? `${p.number} (${p.name})` : p.name)).join(", ")}` : " — use list_projects"}`);
  }
  return loadProject(ctx, hit.id);
}

/**
 * A version address: its id; "<project>@<label>" (e.g. DEMO-001@2, DEMO-001@2-ACME.1); or just the
 * project, meaning its main-line working version, else its newest main-line version.
 */
async function resolveVersion(ctx: Ctx, ref: string): Promise<string> {
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

async function readVersion(env: Env, ref: string) {
  const id = await resolveVersion(env.ctx, ref);
  const a = await loadVersion(env.ctx, id);
  return { a, doc: parseDoc(a.version.doc) };
}
const vName = (a: { project: { name: string; number: string | null }; version: { label: string; status: string } }) => `${a.project.number ? a.project.number + " " : ""}${a.project.name} v${a.version.label} (${statusLabel(a.version.status).toLowerCase()})`;

/* ------------------------------------------------------------------ */
/* Changing a drawing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Apply a change to a working version. With the version open in a live editor, the change goes
 * through the live room (everyone sees it at once); otherwise it is saved like an editor save.
 */
async function editDrawing(env: Env, ref: string, tool: string, change: (d: Doc) => string): Promise<string> {
  if (env.token.scope !== "EDIT") throw new ToolError("This access token is read-only — create one with edit access to change drawings");
  if (!env.ctx.settings.mcp.allowEdits) throw new ToolError("Assistants may not edit drawings in this workspace (Administration → AI assistants)");
  const id = await resolveVersion(env.ctx, ref);
  const a = await loadVersion(env.ctx, id, { withDoc: false });
  try {
    assertEditable(a);
  } catch {
    throw new ToolError(`${vName(a)} cannot be changed: ${a.reason ?? "not a working version"}. ${WORKING.includes(a.version.status) ? "" : "Start a new version (start_new_version) to make changes."}`);
  }
  let summary = "";
  const run = (base: Doc) =>
    immer.produce(base, (d: Doc) => {
      summary = change(d);
    });
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
  await db.project.update({ where: { id: a.project.id }, data: { updatedAt: new Date() } }).catch(() => {});
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: env.ctx.user.id, type: "mcp.edit", data: { tool, label: a.version.label, summary: summary.slice(0, 500), token: env.token.name, live: !!live } });
  return `${summary}\n(${vName(a)} — saved${live ? ", shown live to everyone who has it open" : ""}. Use commit_changes to record a commit when a set of changes is done.)`;
}

const guard = <T,>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof AddressError || e instanceof EditError) throw new ToolError(e.message);
    throw e;
  }
};

/** a symbol to place: a library element, the symbol of a component already in the drawing, or a symbol name in the drawing */
async function symbolFor(env: Env, doc: Doc, s: { library_id?: string; like?: string; symbol?: string }): Promise<ElementDef> {
  if (s.library_id) {
    assertMember(env.ctx);
    const acc = await loadElement(env.ctx, s.library_id).catch(() => null);
    if (!acc) throw new ToolError(`No library element ${s.library_id} — use search_library`);
    if (acc.el.kind !== "ELEMENT") throw new ToolError("That library item is a block, not a single symbol");
    let content = acc.el.content;
    let rev = acc.el.revision;
    let meta = acc.el.meta;
    if (acc.viewerRevision !== acc.el.revision) {
      const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: acc.el.id, revision: acc.viewerRevision } } });
      if (r) ((content = r.content), (rev = r.revision), (meta = r.meta || meta));
    }
    const id = `lib:${acc.el.id}@${rev}`;
    if (doc.defs[id]) return doc.defs[id];
    const def = parseElmt(content, { id, category: acc.el.category });
    def.id = id;
    def.source = { libraryElementId: acc.el.id, revision: rev, status: acc.el.status };
    if (acc.el.prefix && !def.prefix) def.prefix = acc.el.prefix;
    def.meta = { ...def.meta, ...Object.fromEntries(Object.entries(J.parse<Record<string, unknown>>(meta, {})).filter(([k, v]) => !k.startsWith("__") && typeof v === "string")) } as Record<string, string>;
    return def;
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

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

const version = z.string().describe('The version: "DEMO-001" (the project\'s working version, else its newest), "DEMO-001@2" (version 2), or a version id');
const page = z.coerce.string().describe('Page number in sheet order ("1"), page title, or page id');
const component = z.string().describe('Component reference, e.g. "K1"; "K1@2" = the part of K1 on page 2; "#1a2b3c4d" = by id');

function tool<S extends z.ZodObject>(t: Omit<Tool, "input" | "run"> & { input: S; run: (args: z.infer<S>, env: Env) => Promise<ToolResult | string> }): Tool {
  return t as unknown as Tool;
}

export const TOOLS: Tool[] = [
  tool({
    name: "list_projects",
    title: "List projects",
    description: "Projects you can open, with their number, latest version and working version. Filter by text.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ query: z.string().optional().describe("Text in the name, number or tags"), archived: z.boolean().optional().describe("List archived projects instead") }),
    run: async ({ query, archived }, { ctx }) => {
      const q = query?.trim();
      const rows = await db.project.findMany({
        where: { AND: [projectScope(ctx), { state: archived ? "ARCHIVED" : "ACTIVE" }, q ? { OR: [{ name: { contains: q } }, { number: { contains: q } }, { tags: { contains: q } }] } : {}] },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: { versions: { orderBy: { seq: "desc" }, omit: { doc: true }, take: 30 } },
      });
      if (!rows.length) return "No projects" + (q ? ` matching "${q}"` : "");
      return [
        `${rows.length} project${rows.length === 1 ? "" : "s"} — number | name | latest version | working version | tags | updated`,
        ...rows.map((p) => {
          const main = p.versions.filter((v) => !v.variantId);
          const latest = main[0] ?? p.versions[0];
          const working = p.versions.find((v) => WORKING.includes(v.status));
          return `${p.number ?? "—"} | ${p.name} | ${latest ? `v${latest.label} ${statusLabel(latest.status).toLowerCase()}` : "-"} | ${working ? `v${working.label}` : "none"} | ${J.parse<string[]>(p.tags, []).join(", ") || "-"} | ${p.updatedAt.toISOString().slice(0, 10)}`;
        }),
      ].join("\n");
    },
  }),
  tool({
    name: "get_project",
    title: "Project details",
    description: "A project's versions (status, summary, author), variants and open reviews. Use the version labels with other tools as <project>@<label>.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ project: z.string().describe("Project number, name or id") }),
    run: async ({ project }, { ctx }) => {
      const { project: p, can } = await findProject(ctx, project);
      const [versions, variants, reviews] = await Promise.all([
        db.version.findMany({ where: { projectId: p.id }, omit: { doc: true }, orderBy: { seq: "desc" } }),
        db.variant.findMany({ where: { projectId: p.id } }),
        db.review.findMany({ where: { version: { projectId: p.id }, status: "OPEN" }, include: { assignments: true } }),
      ]);
      const names = new Map((await db.user.findMany({ where: { id: { in: [...new Set(versions.map((v) => v.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return [
        `${p.number ? p.number + " — " : ""}${p.name}${p.state === "ARCHIVED" ? " (archived)" : ""}`,
        p.description ? `Description: ${p.description}` : "",
        `Your access: ${["project.view", "project.edit", "review.comment", "project.manage"].filter((x) => can(x as never)).join(", ")}`,
        "",
        "Versions (newest first) — label | status | line | summary | author | created",
        ...versions.map((v) => `v${v.label} | ${statusLabel(v.status)}${WORKING.includes(v.status) ? " (working, editable)" : ""} | ${variants.find((x) => x.id === v.variantId)?.code ?? "main"} | ${v.summary || "-"} | ${names.get(v.createdById) ?? "?"} | ${v.createdAt.toISOString().slice(0, 10)}`),
        ...(variants.length ? ["", "Variants: " + variants.map((x) => `${x.code} "${x.name}"${x.customer ? ` for ${x.customer}` : ""} from v${x.baseLabel}${x.state === "ARCHIVED" ? " (archived)" : ""}`).join("; ")] : []),
        ...(reviews.length ? ["", "Open reviews: " + reviews.map((r) => `v${versions.find((v) => v.id === r.versionId)?.label}: ${r.assignments.filter((x) => x.decision === "PENDING").length} pending`).join("; ")] : []),
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  }),
  tool({
    name: "get_drawing",
    title: "Drawing overview",
    description: "Start here for a version: status and whether you may edit it, pages with their numbers, component and wire counts, numbering rules and wiring standard, open comments.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version }),
    run: async ({ version: v }, env) => {
      const { a, doc } = await readVersion(env, v);
      const open = await db.comment.count({ where: { versionId: a.version.id, parentId: null, status: { in: ["OPEN", "REOPENED"] } } });
      const canEdit = a.editable && env.token.scope === "EDIT" && env.ctx.settings.mcp.allowEdits;
      return [
        `${vName(a)} — version id ${a.version.id}`,
        canEdit ? "You can edit this version." : `Read-only for you: ${a.reason ?? (env.token.scope !== "EDIT" ? "read-only token" : "edits by assistants are off")}`,
        a.canComment ? `You can comment. ${open} open comment thread${open === 1 ? "" : "s"}.` : "",
        "",
        overviewText(doc),
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  }),
  tool({
    name: "list_components",
    title: "List components",
    description: "Components with reference, page and border cell (e.g. 3C), symbol, data (name, rating, part number, manufacturer) and pins. Filter by page or text.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, page: page.optional(), query: z.string().optional().describe("Text in reference, symbol or data"), limit: z.number().int().min(1).max(2000).optional() }),
    run: async ({ version: v, page: pg, query, limit }, env) => {
      const { doc } = await readVersion(env, v);
      return guard(() => componentsText(doc, { page: pg !== undefined ? findPage(doc, pg) : undefined, query, limit }));
    },
  }),
  tool({
    name: "get_component",
    title: "Component details",
    description: "One component (all parts of the device: coil and contacts, other sheets) with its data and what every pin is connected to (terminals and wire numbers).",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, component }),
    run: async ({ version: v, component: c }, env) => {
      const { doc } = await readVersion(env, v);
      return guard(() => componentText(doc, withLinkedParts(doc, findComponents(doc, c))));
    },
  }),
  tool({
    name: "list_wires",
    title: "List wires",
    description: "Wires (conductors) with id, page, wire number, the pins at both ends, potential/use, colour and cross-section, cable core. Use the ids (#…) with set_wire and delete_wires.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, page: page.optional(), query: z.string().optional().describe("Text in number, ends, colour …"), unnumbered: z.boolean().optional().describe("Only wires without a number"), limit: z.number().int().min(1).max(5000).optional() }),
    run: async ({ version: v, page: pg, query, unnumbered, limit }, env) => {
      const { doc } = await readVersion(env, v);
      return guard(() => wiresText(doc, { page: pg !== undefined ? findPage(doc, pg) : undefined, query, unnumbered, limit }));
    },
  }),
  tool({
    name: "get_netlist",
    title: "Netlist",
    description: "Every conductor (electrical net) across the project, followed through junctions, terminals, off-page arrows and mated connectors: its wires (number, potential, colour, section) and the terminals it joins (REF:pin@page). The basis for an electrical review.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, page: page.optional().describe("Only conductors touching this page") }),
    run: async ({ version: v, page: pg }, env) => {
      const { doc } = await readVersion(env, v);
      return guard(() => netlistText(doc, { page: pg !== undefined ? findPage(doc, pg) : undefined }));
    },
  }),
  tool({
    name: "check_drawing",
    title: "Run rule checks",
    description: "Volt's electrical rule check and drawing validation: short circuits between potentials, PE and polarity, open folio reports, dead ends, duplicate references and wire numbers, conductor sizes against protection, safety items. Same checks as the Volt AI Reviewer.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version }),
    run: async ({ version: v }, env) => {
      const { a, doc } = await readVersion(env, v);
      return `${vName(a)}\n${checksText(doc).text}`;
    },
  }),
  tool({
    name: "render_page",
    title: "Picture of a page",
    description: "A PNG picture of one page as drawn (with the border grid: columns numbered, rows lettered, used as cells like 3C). Use it to see the layout before placing or moving components.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, page, width: z.number().int().min(600).max(3200).optional().describe("Picture width in pixels (default 1800)") }),
    run: async ({ version: v, page: pg, width }, env) => {
      const { a, doc } = await readVersion(env, v);
      const p = guard(() => findPage(doc, pg));
      const svg = pageToSvg(doc, p, { measure: approxMeasure, lod: 100, background: "#ffffff", pageIndex: sheets(doc).indexOf(p), pageCount: sheets(doc).length });
      const png = svgToPng(svg, width ?? 1800);
      return {
        content: [
          { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
          { type: "text", text: `Page ${sheetNo(doc, p)} "${p.title}" of ${vName(a)}: ${p.border.cols} columns × ${p.border.rows} rows (cells 1A … ${p.border.cols}${String.fromCharCode(64 + p.border.rows)}); scene units: column width ${p.border.colW}, row height ${p.border.rowH}, grid ${doc.grid?.size ?? 10}.` },
        ],
      };
    },
  }),
  tool({
    name: "list_comments",
    title: "Review comments",
    description: "Comment threads on a version (open by default): who, where (component or wire), status and replies. Includes Volt AI Reviewer findings.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, status: z.enum(["open", "all"]).optional() }),
    run: async ({ version: v, status }, env) => {
      const { a, doc } = await readVersion(env, v);
      const rows = await db.comment.findMany({ where: { versionId: a.version.id }, include: { author: { select: { name: true, isBot: true } } }, orderBy: { createdAt: "asc" } });
      const roots = rows.filter((c) => !c.parentId && (status === "all" || ["OPEN", "REOPENED"].includes(c.status)));
      if (!roots.length) return `No ${status === "all" ? "" : "open "}comments on ${vName(a)}`;
      const where = (c: (typeof rows)[number]) => {
        const an = J.parse<{ type: string; id?: string } | null>(c.anchor, null);
        const pageN = c.pageId ? doc.pages.find((p) => p.id === c.pageId) : undefined;
        let at = pageN ? `page ${sheetNo(doc, pageN)}` : "";
        if (an?.id && an.type === "element") at += ` ${doc.pages.flatMap((p) => p.elements).find((e) => e.id === an.id)?.info.label ?? "component"}`;
        if (an?.id && an.type === "wire") at += ` wire ${doc.pages.flatMap((p) => p.wires).find((w) => w.id === an.id)?.label ?? short(an.id)}`;
        return at.trim();
      };
      const who = (c: (typeof rows)[number]) => J.parse<{ name?: string; server?: string } | null>(c.externalAuthor, null)?.name ?? `${c.author.name}${c.author.isBot ? " (AI reviewer)" : ""}`;
      return roots
        .map((c) => [`[${c.status}] ${c.id} — ${who(c)}${where(c) ? ` on ${where(c)}` : ""}: ${c.body}`, ...rows.filter((r) => r.parentId === c.id).map((r) => `   ↳ ${who(r)}: ${r.body}`)].join("\n"))
        .join("\n\n");
    },
  }),
  tool({
    name: "search_library",
    title: "Search the component library",
    description: "Symbols in the organization and personal library (relays, breakers, terminals, PLC cards …) with their id for place_component.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ query: z.string().describe("e.g. contactor, terminal, 24V supply, emergency stop"), limit: z.number().int().min(1).max(50).optional() }),
    run: async ({ query, limit }, { ctx }) => {
      assertMember(ctx);
      const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 6);
      const rows = await db.libraryElement.findMany({
        where: { AND: [visibleWhere(ctx), { kind: "ELEMENT" }, ...terms.map((t) => ({ OR: [{ name: { contains: t } }, { tags: { contains: t } }, { category: { contains: t } }, { description: { contains: t } }, { prefix: { contains: t } }] }))] },
        take: limit ?? 20,
        orderBy: [{ status: "asc" }, { name: "asc" }],
        select: { id: true, name: true, category: true, prefix: true, status: true, revision: true, content: true },
      });
      if (!rows.length) return `Nothing in the library for "${query}"`;
      return [
        "library_id | name | category | prefix | status | pins",
        ...rows.map((r) => {
          let pins = "";
          try {
            pins = parseElmt(r.content, { id: r.id }).pins.map((p) => p.number || p.name).filter(Boolean).join(",");
          } catch {}
          return `${r.id} | ${r.name} | ${r.category || "-"} | ${r.prefix || "-"} | ${r.status.toLowerCase()} | ${pins || "-"}`;
        }),
      ].join("\n");
    },
  }),

  tool({
    name: "create_component",
    title: "Create a new component symbol",
    description: `Draw a new component symbol (e.g. a relay with its pins, a sensor, a PLC card, a connector) and save it to your personal component library, then place it with place_component library_id=… . Returns a picture of the symbol to check; set save=false to preview first, or revise=<library_id> to change one you created.
Drawing rules (IEC 60617 style, like Volt's library): x to the right, y DOWN; the grid is 10; draw around (0, 0). Every pin sits exactly on a multiple of 10 (5 only if unavoidable) at the OUTER end of a straight 10-long lead line you also draw; direction = the side the wire leaves (n up, s down, e right, w left). Vertical symbols (contacts, coils, fuses, lamps, motors) have pins at the top (n) and bottom (s) on x = 0, typically 20–40 tall. Boxes with many pins: pins on the left (w) and right (e), one per 10 units. Shapes: line (2 points), polyline/polygon (2+ points), rect/ellipse/arc (x, y = top-left of the bounding box, w, h), circle (x, y, w = diameter), arc (start_deg, sweep_deg; 0 = 3 o'clock, counter-clockwise), text (x, y = baseline start, size 6–9, fixed markings only such as M, 3~, +, −). Never draw the reference (K1 …) — Volt adds it. filled only for small solid marks; dashed for mechanical links.`,
    access: "edit",
    input: z.object({
      name: z.string().min(1).max(80).describe("e.g. 'Safety relay 24 V DC, 2 NO'"),
      category: z.string().max(80).optional().describe("Library folder, e.g. 'Relays & contactors/Safety relays'"),
      prefix: z.string().max(4).optional().describe("IEC 81346 letter(s): K, Q, F, X, M, H, S, B, T, G, P, R, C, U, A …"),
      description: z.string().max(200).optional(),
      link_type: z.enum(["simple", "master", "slave", "terminal"]).optional().describe("master = coil with contacts elsewhere, slave = a contact of a master, terminal = terminal block, else simple"),
      shapes: z
        .array(
          z.object({
            kind: z.enum(["line", "rect", "circle", "ellipse", "arc", "polyline", "polygon", "text"]),
            points: z.array(z.object({ x: z.number(), y: z.number() })).max(200).optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            w: z.number().optional(),
            h: z.number().optional(),
            start_deg: z.number().optional(),
            sweep_deg: z.number().optional(),
            text: z.string().max(40).optional(),
            size: z.number().optional(),
            filled: z.boolean().optional(),
            dashed: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(400),
      pins: z.array(z.object({ x: z.number(), y: z.number(), direction: z.enum(["n", "e", "s", "w"]), number: z.string().max(16), name: z.string().max(32).optional() })).max(128),
      manufacturer: z.string().max(200).optional(),
      part_number: z.string().max(200).optional(),
      save: z.boolean().optional().describe("false = only return the picture (default true)"),
      revise: z.string().optional().describe("library_id of a component you created: save this drawing as its next revision"),
    }),
    run: async (x, env) => {
      assertMember(env.ctx);
      const sym: AiSymbol = {
        name: x.name,
        category: x.category ?? "Custom",
        prefix: x.prefix ?? "",
        description: x.description ?? "",
        link_type: x.link_type ?? "simple",
        notes: "",
        pins: x.pins.map((p) => ({ x: p.x, y: p.y, direction: p.direction, number: p.number, name: p.name ?? p.number })),
        shapes: x.shapes.map((s) => ({ kind: s.kind, points: s.points ?? [], x: s.x ?? null, y: s.y ?? null, w: s.w ?? null, h: s.h ?? null, start_deg: s.start_deg ?? null, sweep_deg: s.sweep_deg ?? null, text: s.text ?? null, size: s.size ?? null, filled: !!s.filled, dashed: !!s.dashed })),
      };
      const { def, warnings } = aiSymbolToDef(sym);
      if (x.manufacturer) def.info.manufacturer = x.manufacturer;
      if (x.part_number) def.info.manufacturer_reference = x.part_number;
      const pinsText = def.pins.map((p) => `${p.number || "?"}(${p.orient})`).join(", ") || "none";
      const picture = (): Content => ({ type: "image", data: Buffer.from(svgToPng(elementSvg(def, { label: `${def.prefix || "?"}1`, pinNumbers: true, pad: 6 }), 480)).toString("base64"), mimeType: "image/png" });
      const notes = warnings.length ? `\nNotes: ${warnings.join(" ")}` : "";
      if (x.save === false) return { content: [picture(), { type: "text", text: `Preview of "${def.name}" (not saved): ${def.prims.length - 1} shapes, pins ${pinsText}.${notes}` }] };
      if (env.token.scope !== "EDIT" || !env.ctx.settings.mcp.allowEdits) throw new ToolError("This token cannot add components to the library");
      const meta: Record<string, string> = {};
      if (x.manufacturer) meta.manufacturer = x.manufacturer;
      if (x.part_number) meta.partNumber = x.part_number;
      const category = normCategory(sym.category);
      let id: string, revision: number;
      if (x.revise) {
        const acc = await loadElement(env.ctx, x.revise).catch(() => null);
        if (!acc || acc.el.ownerId !== env.ctx.user.id || !acc.canEdit) throw new ToolError("You can revise only components you created (others: change them in Library)");
        if (acc.el.visibility === "ORG" || acc.el.kind !== "ELEMENT") throw new ToolError("This component is published to the organization — change it in Library, where the approval workflow applies");
        const upd = await addRevision(acc.el, serializeElmt({ ...def, uuid: acc.el.uuid }), env.ctx.user.id, `Changed via ${via(env)}`, { name: def.name, category, prefix: def.prefix || acc.el.prefix, description: sym.description, meta: JSON.stringify({ ...J.parse<Record<string, unknown>>(acc.el.meta, {}), ...meta }) });
        ((id = upd.id), (revision = upd.revision));
        await audit({ workspaceId: env.ctx.workspace.id, actorId: env.ctx.user.id, type: "library.update", data: { id, name: def.name, revision, via: via(env) } });
      } else {
        const lib = await writableLibrary(env.ctx, null);
        const uuid = newUuid();
        const el = await createElementRecord({
          libraryId: lib.id,
          ownerId: env.ctx.user.id,
          name: def.name,
          category,
          prefix: def.prefix || guessPrefix({ ...def, category }),
          description: sym.description,
          tags: ["ai"],
          uuid,
          content: serializeElmt({ ...def, uuid }),
          meta,
          visibility: "PRIVATE",
          note: `Created via ${via(env)}`,
        });
        ((id = el.id), (revision = el.revision));
        await audit({ workspaceId: env.ctx.workspace.id, actorId: env.ctx.user.id, type: "library.create", data: { id, name: def.name, kind: "ELEMENT", visibility: "PRIVATE", status: el.status, via: via(env) } });
      }
      return {
        content: [
          picture(),
          { type: "text", text: `${x.revise ? "Saved revision " + revision + " of" : "Created"} "${def.name}" in your personal library — library_id ${id} (private draft; publish it to the organization in Library). Pins ${pinsText}. Place it with place_component library_id=${id}.${notes}` },
        ],
      };
    },
  }),

  /* ---------------------------------- comments ---------------------------------- */
  tool({
    name: "add_comment",
    title: "Add a review comment",
    description: "Comment on a version, pinned to a component, a wire or a page — how findings of a review are reported. Works on versions in review too.",
    access: "comment",
    input: z.object({ version, body: z.string().min(1).max(10_000), component: component.optional(), wire: z.string().optional().describe("Wire id (#…) or number"), page: page.optional() }),
    run: async ({ version: v, body, component: c, wire, page: pg }, env) => {
      const { a, doc } = await readVersion(env, v);
      let pageId: string | null = null;
      let anchor: { type: "element" | "wire" | "point"; id?: string; x: number; y: number } | null = null;
      guard(() => {
        if (c) {
          const x = findComponent(doc, c);
          pageId = x.page.id;
          anchor = { type: "element", id: x.e.id, x: x.e.x, y: x.e.y };
        } else if (wire) {
          const ws = findWires(doc, wire);
          const w = ws[0];
          const mid = w.w.pts[Math.floor(w.w.pts.length / 2)];
          pageId = w.page.id;
          anchor = { type: "wire", id: w.w.id, x: mid.x, y: mid.y };
        } else if (pg !== undefined) pageId = findPage(doc, pg).id;
      });
      const dto = await addComment(env.ctx, a.version.id, { body, pageId, anchor }, { via: via(env) });
      return `Comment ${dto.id} added to ${vName(a)}${anchor ? ` on ${c ?? wire}` : pageId ? " on the page" : ""}`;
    },
  }),
  tool({
    name: "reply_to_comment",
    title: "Reply to a comment",
    description: "Reply in a comment thread (comment id from list_comments).",
    access: "comment",
    input: z.object({ comment: z.string().describe("Comment id"), body: z.string().min(1).max(10_000) }),
    run: async ({ comment, body }, env) => {
      const c = await db.comment.findUnique({ where: { id: comment }, select: { versionId: true, parentId: true } });
      if (!c?.versionId) throw new ToolError("No such comment");
      const dto = await addComment(env.ctx, c.versionId, { body, parentId: c.parentId ?? comment }, { via: via(env) });
      return `Reply ${dto.id} added`;
    },
  }),
  tool({
    name: "set_comment_status",
    title: "Resolve or reopen a comment",
    description: "Mark a thread resolved (fixed), wont_fix, or reopen it. Resolve AI-reviewer findings after fixing them.",
    access: "comment",
    input: z.object({ comment: z.string(), status: z.enum(["resolved", "wont_fix", "reopened"]) }),
    run: async ({ comment, status }, env) => {
      const s = status === "resolved" ? "RESOLVED" : status === "wont_fix" ? "REJECTED" : "REOPENED";
      await setCommentStatus(env.ctx, comment, s, { via: via(env) });
      return `Comment ${comment} is ${status.replace("_", " ")}`;
    },
  }),

  /* ---------------------------------- edits ---------------------------------- */
  tool({
    name: "rename_component",
    title: "Rename a component",
    description: "Change a component's reference (e.g. K7 → K3). All parts of the device (contacts, other sheets) are renamed with it, as in the editor; the new reference is locked against automatic renumbering. Refuses a reference that is already used.",
    access: "edit",
    input: z.object({ version, component, new_reference: z.string().min(1).max(100) }),
    run: async ({ version: v, component: c, new_reference }, env) => editDrawing(env, v, "rename_component", (d) => guard(() => renameComponent(d, c, new_reference))),
  }),
  tool({
    name: "set_component_data",
    title: "Set component data",
    description: "Set a component's name (description), rating, part number, manufacturer, supplier, location, function or comment. Empty string clears a field. Device data goes on its main part (the coil, not the contacts) unless all_parts is set.",
    access: "edit",
    input: z.object({
      version,
      component,
      description: z.string().max(500).optional(),
      rating: z.string().max(200).optional(),
      part_number: z.string().max(200).optional(),
      manufacturer: z.string().max(200).optional(),
      supplier: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      function: z.string().max(200).optional(),
      comment: z.string().max(500).optional(),
      other: z.record(z.string().max(60), z.string().max(500)).optional().describe("Other element information fields by name"),
      all_parts: z.boolean().optional(),
      lock_reference: z.boolean().optional().describe("Lock (true) or unlock (false) the reference against renumbering"),
    }),
    run: async (x, env) => {
      const fields: Partial<Record<InfoField, string>> = {};
      for (const k of ["description", "rating", "part_number", "manufacturer", "supplier", "location", "function", "comment"] as const) if (x[k] !== undefined) fields[k] = x[k];
      if (!Object.keys(fields).length && !x.other && x.lock_reference === undefined) throw new ToolError("Nothing to set");
      return editDrawing(env, x.version, "set_component_data", (d) => guard(() => setComponentData(d, x.component, fields, x.other ?? {}, { allParts: x.all_parts, lockReference: x.lock_reference })));
    },
  }),
  tool({
    name: "renumber_components",
    title: "Renumber references",
    description: "Fix reference numbering. close_gaps: K1, K2, K4 → K1, K2, K3 (locked references kept). by_rules: number again by the project's numbering rules, sheet by sheet left to right (device parts keep sharing a reference). Use dry_run to see the plan first.",
    access: "edit",
    input: z.object({
      version,
      mode: z.enum(["close_gaps", "by_rules"]),
      pages: z.array(z.coerce.string()).optional().describe("by_rules: only these pages"),
      prefixes: z.array(z.string()).optional().describe("Only these prefixes, e.g. [\"K\", \"Q\"]"),
      only_unnamed: z.boolean().optional().describe("by_rules: only components without a reference"),
      dry_run: z.boolean().optional(),
    }),
    run: async ({ version: v, mode, pages, prefixes, only_unnamed, dry_run }, env) => {
      if (dry_run) {
        const { doc } = await readVersion(env, v);
        const ch = guard(() => planReferences(doc, { mode, prefixes, onlyUnnamed: only_unnamed, pageIds: pages?.map((p) => findPage(doc, p).id) }));
        return `Plan (not applied): ${refChangesText(ch)}`;
      }
      return editDrawing(env, v, "renumber_components", (d) => {
        const ch = guard(() => planReferences(d, { mode, prefixes, onlyUnnamed: only_unnamed, pageIds: pages?.map((p) => findPage(d, p).id) }));
        applyReferences(d, ch);
        return `Renumbered: ${refChangesText(ch)}`;
      });
    },
  }),
  tool({
    name: "number_wires",
    title: "Number wires automatically",
    description: "Volt's automatic wire numbering: circuits are traced across sheets, their voltage class detected, and wires numbered with the project's scheme (e.g. B012A). mode new (default): keep numbers that already follow the scheme and number the rest (rail names such as L1.4 are replaced when the project's numbering says so); all: renumber everything. Numbers typed by hand (locked) are always kept. Use dry_run to see the plan.",
    access: "edit",
    input: z.object({ version, mode: z.enum(["new", "all"]).optional(), pages: z.array(z.coerce.string()).optional(), dry_run: z.boolean().optional() }),
    run: async ({ version: v, mode, pages, dry_run }, env) => {
      if (dry_run) {
        const { doc } = await readVersion(env, v);
        return "Plan (not applied):\n" + guard(() => numberWires(doc, mode ?? "new", pages?.map((p) => findPage(doc, p).id), false)).text;
      }
      return editDrawing(env, v, "number_wires", (d) => guard(() => numberWires(d, mode ?? "new", pages?.map((p) => findPage(d, p).id), true)).text);
    },
  }),
  tool({
    name: "set_wire",
    title: "Set conductor data",
    description: "Set wire number, potential (L1 L2 L3 L N DC+ DC0 DC- PE signal), use (power, control, external), insulation colour (IEC 60757 code, e.g. BU, BK, GNYE), cross-section (\"1.5 mm²\", \"16 AWG\"), cable and core — for one or more wires. A typed number is locked against automatic numbering. Empty string clears.",
    access: "edit",
    input: z.object({
      version,
      wires: z.array(z.string()).min(1).max(500).describe("Wire ids (#…) or wire numbers"),
      number: z.string().max(60).optional(),
      lock_number: z.boolean().optional(),
      potential: z.string().optional(),
      use: z.string().optional(),
      colour: z.string().max(40).optional(),
      section: z.string().max(40).optional(),
      cable: z.string().max(40).optional(),
      core: z.string().max(40).optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "set_wire", (d) =>
        guard(() => {
          const ids = [...new Set(x.wires.flatMap((s) => findWires(d, s).map((w) => w.w.id)))];
          return setWires(d, ids, { number: x.number, numberLocked: x.lock_number, potential: x.potential, use: x.use, colour: x.colour, section: x.section, cable: x.cable, core: x.core });
        }),
      ),
  }),
  tool({
    name: "connect_pins",
    title: "Connect two pins",
    description: "Draw a wire between two pins on the same page, routed orthogonally (like Connect pins in the editor). Pins: \"K1:A1\", \"Q1:2\", terminals \"X1:3:1\" (top) / \"X1:3:2\" (bottom). For connections across pages use off-page arrows.",
    access: "edit",
    input: z.object({ version, from: z.string(), to: z.string(), number: z.string().max(60).optional().describe("Wire number to give it") }),
    run: async ({ version: v, from, to, number }, env) => editDrawing(env, v, "connect_pins", (d) => guard(() => connectPins(d, from, to, { number }).text)),
  }),
  tool({
    name: "delete_wires",
    title: "Delete wires",
    description: "Delete wires (ids from list_wires, or wire numbers). Junctions left with fewer than three wires are cleaned up.",
    access: "edit",
    annotations: { destructiveHint: true },
    input: z.object({ version, wires: z.array(z.string()).min(1).max(500) }),
    run: async ({ version: v, wires }, env) => editDrawing(env, v, "delete_wires", (d) => guard(() => deleteWires(d, [...new Set(wires.flatMap((s) => findWires(d, s).map((w) => w.w.id)))]))),
  }),
  tool({
    name: "place_component",
    title: "Place a component",
    description: "Place a symbol on a page at a border cell (e.g. \"4B\", centre of the cell) or at x/y. The symbol: library_id from search_library, like = copy the symbol of an existing component (e.g. \"K1\"), or symbol = a symbol name used in the drawing. Gets the next free reference unless one is given; free wire ends on its pins attach.",
    access: "edit",
    input: z.object({
      version,
      page,
      library_id: z.string().optional(),
      like: z.string().optional(),
      symbol: z.string().optional(),
      cell: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: z.number().optional().describe("Degrees: 0, 90, 180, 270"),
      reference: z.string().max(100).optional(),
      description: z.string().max(500).optional(),
      part_number: z.string().max(200).optional(),
      manufacturer: z.string().max(200).optional(),
      rating: z.string().max(200).optional(),
    }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const def = await symbolFor(env, doc, x);
      return editDrawing(env, x.version, "place_component", (d) =>
        guard(() => {
          const pg = findPage(d, x.page);
          const at = positionOf(d, pg, { cell: x.cell, x: x.x, y: x.y });
          const data: Record<string, string> = {};
          if (x.description) data.description = x.description;
          if (x.part_number) data.manufacturer_reference = x.part_number;
          if (x.manufacturer) data.manufacturer = x.manufacturer;
          if (x.rating) data.rating = x.rating;
          return placeComponent(d, pg, structuredClone(def), at, { rotation: x.rotation, reference: x.reference, data });
        }),
      );
    },
  }),
  tool({
    name: "move_component",
    title: "Move a component",
    description: "Move a component to a border cell or x/y, or by dx/dy. Its wires follow (rubber-band), as when dragging in the editor.",
    access: "edit",
    input: z.object({ version, component, cell: z.string().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() }),
    run: async (x, env) =>
      editDrawing(env, x.version, "move_component", (d) =>
        guard(() => {
          const c = findComponent(d, x.component);
          const at = x.cell || (x.x !== undefined && x.y !== undefined) ? positionOf(d, c.page, { cell: x.cell, x: x.x, y: x.y }) : undefined;
          if (!at && x.dx === undefined && x.dy === undefined) throw new EditError("Give cell, x/y or dx/dy");
          return moveComponent(d, x.component, { at, dx: x.dx, dy: x.dy });
        }),
      ),
  }),
  tool({
    name: "delete_component",
    title: "Delete a component",
    description: "Delete one component (one part: give K1@2 for the part on page 2). Its wires stay with free ends, as in the editor. close_gaps renumbers its prefix without the gap.",
    access: "edit",
    annotations: { destructiveHint: true },
    input: z.object({ version, component, close_gaps: z.boolean().optional() }),
    run: async ({ version: v, component: c, close_gaps }, env) => editDrawing(env, v, "delete_component", (d) => guard(() => deleteComponent(d, c, { closeGaps: close_gaps }))),
  }),
  tool({
    name: "commit_changes",
    title: "Commit",
    description: "Record a commit of the working version with a message (git-like history in Volt): do this after a set of related changes, e.g. \"Fix duplicate references K1–K3\".",
    access: "edit",
    input: z.object({ version, message: z.string().min(1).max(2000) }),
    run: async ({ version: v, message }, env) => {
      if (env.token.scope !== "EDIT" || !env.ctx.settings.mcp.allowEdits) throw new ToolError("This token cannot change drawings");
      const id = await resolveVersion(env.ctx, v);
      const a = await loadVersion(env.ctx, id, { withDoc: false });
      if (!a.editable) throw new ToolError(`${vName(a)} is not a working version you can edit`);
      await flushLive(id);
      const c = await createCommit(env.ctx, id, message);
      if (!c) return "Nothing to commit — no changes since the last commit";
      await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: env.ctx.user.id, type: "version.commit", data: { seq: c.seq, message: message.slice(0, 200), label: a.version.label, via: via(env) } });
      const s = J.parse<{ added?: number; removed?: number; changed?: number; moved?: number }>(c.stats, {});
      return `Commit #${c.seq} on ${vName(a)}: ${s.added ?? 0} added, ${s.removed ?? 0} removed, ${s.changed ?? 0} changed, ${s.moved ?? 0} moved`;
    },
  }),
  tool({
    name: "start_new_version",
    title: "Start a new version",
    description: "Start a new working version (draft) from an existing one (default: the released version, else the newest) — needed before changing a version that is in review, approved or released. A signed version becomes obsolete when revised.",
    access: "edit",
    input: z.object({ project: z.string(), from_version: z.string().optional().describe("Label to start from, e.g. \"2\""), summary: z.string().min(1).max(500).describe("What the new version is for") }),
    run: async ({ project, from_version, summary }, env) => {
      if (env.token.scope !== "EDIT" || !env.ctx.settings.mcp.allowEdits) throw new ToolError("This token cannot change drawings");
      const { project: p } = await findProject(env.ctx, project);
      const parent = from_version
        ? await db.version.findFirst({ where: { projectId: p.id, label: from_version.replace(/^v/i, "") } })
        : ((await db.version.findFirst({ where: { projectId: p.id, variantId: null, status: "RELEASED" }, orderBy: { seq: "desc" } })) ?? (await db.version.findFirst({ where: { projectId: p.id, variantId: null }, orderBy: { seq: "desc" } })));
      if (!parent) throw new ToolError(`No version ${from_version ?? ""} in ${p.name}`);
      const r = await startVersion(env.ctx, p.id, { parentId: parent.id, summary });
      return `Started v${r.label} from v${parent.label} in ${p.name} — version ${p.number ?? p.id}@${r.label} (id ${r.id})${r.obsoleted ? `; v${r.obsoleted} is now obsolete` : ""}`;
    },
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** run a tool: permission by access level, errors the assistant can act on become tool results */
export async function callTool(name: string, args: unknown, env: Env): Promise<ToolResult> {
  const t = TOOL_BY_NAME.get(name);
  if (!t) throw new HttpError(404, `Unknown tool ${name}`);
  if (t.access !== "read" && env.token.scope !== "EDIT") return { content: [{ type: "text", text: "This access token is read-only: it can read and check drawings, not comment or change them." }], isError: true };
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` }], isError: true };
  try {
    const out = await (t.run as (a: unknown, e: Env) => Promise<ToolResult | string>)(parsed.data, env);
    return typeof out === "string" ? text(out) : out;
  } catch (e) {
    if (e instanceof ToolError || e instanceof AddressError || e instanceof EditError || e instanceof HttpError) return { content: [{ type: "text", text: e.message }], isError: true };
    console.error("[mcp]", name, e);
    return { content: [{ type: "text", text: `Internal error in ${name}` }], isError: true };
  }
}

export function toolList(env: Env) {
  return TOOLS.filter((t) => t.access === "read" || env.token.scope === "EDIT").map((t) => {
    const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: schema,
      annotations: { title: t.title, readOnlyHint: t.access === "read", ...(t.annotations ?? {}) },
    };
  });
}

export { HttpError };
