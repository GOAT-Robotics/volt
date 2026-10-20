/**
 * MCP tools for history and workflow: undo, commit history, comparing versions and commits,
 * restoring a commit, submitting for review and taking a version back, and reports / files.
 */
import "server-only";
import { z } from "zod";
import { db } from "../db";
import { rateLimit } from "../ratelimit";
import { HttpError } from "../session";
import { clientDoc, loadVersion, parseDoc } from "../versioning";
import { flushLive } from "../live/hooks";
import { baselineOf, commitDoc, historyOf } from "../commits";
import { submitForReview } from "../submit";
import { recallVersion } from "../release";
import { parseRoles, rolesAllow, type Role } from "../roles";
import { diffDocs } from "@/core/diff";
import type { Doc } from "@/core/model";
import { reportTable, reportText, type ReportKind } from "./project";
import { FILE_FORMATS, fileMime, makeFile, signFileLink, type FileFormat } from "./files";
import { sheetNo } from "./doc";
import { assertCanEdit, editDrawing, page, plural, readVersion, resolveVersion, tool, ToolError, undoChanges, undoEntries, version, via, vName, type Env, type Tool } from "./kit";

/** "#12" / "12" → a commit of the project; "last_commit" → the version's baseline */
async function commitByRef(projectId: string, ref: string) {
  const n = Number(ref.replace(/^#/, ""));
  const c = Number.isInteger(n) ? await db.commit.findFirst({ where: { projectId, seq: n }, select: { id: true, seq: true, message: true, versionId: true } }) : await db.commit.findFirst({ where: { projectId, id: ref }, select: { id: true, seq: true, message: true, versionId: true } });
  if (!c) throw new ToolError(`No commit ${ref} in this project — list_history shows them`);
  return c;
}

/** what to compare with: another version, a commit (#12), or the last commit (uncommitted changes) */
async function otherDoc(env: Env, a: { project: { id: string }; version: { id: string; headCommitId: string | null; baseCommitId: string | null; parentId: string | null } }, ref: string | undefined): Promise<{ doc: Doc | null; label: string }> {
  if (!ref || ref === "last_commit" || ref === "uncommitted") {
    const b = await baselineOf(a.version);
    return { doc: b.doc, label: b.kind === "empty" ? "an empty drawing" : `the last commit (${b.label})` };
  }
  if (/^#?\d+$/.test(ref.trim())) {
    const c = await commitByRef(a.project.id, ref.trim());
    return { doc: await commitDoc(c.id), label: `commit #${c.seq} "${c.message}"` };
  }
  const id = await resolveVersion(env.ctx, ref);
  await flushLive(id);
  const o = await loadVersion(env.ctx, id);
  return { doc: clientDoc(parseDoc(o.version.doc)), label: vName(o) };
}

export const WORKFLOW_TOOLS: Tool[] = [
  tool({
    name: "undo",
    title: "Undo your changes",
    area: "History & workflow",
    description: "Undo the last change(s) made with this access token on a version (newest first; other people's changes in between are kept). Remembered since the server started; for older states use compare_versions and restore_commit.",
    access: "edit",
    input: z.object({ version, steps: z.number().int().min(1).max(50).optional().describe("How many changes (default 1)"), list: z.boolean().optional().describe("Only list what can be undone") }),
    run: async (x, env) => {
      if (x.list) {
        const id = await resolveVersion(env.ctx, x.version);
        const e = undoEntries(id, env.token.id);
        return e.length ? `Can undo (newest first):\n${[...e].reverse().map((u, i) => `${i + 1}. ${u.tool}: ${u.summary} (${new Date(u.at).toISOString().slice(11, 19)} UTC)`).join("\n")}` : "Nothing to undo";
      }
      return undoChanges(env, x.version, x.steps ?? 1);
    },
  }),
  tool({
    name: "list_history",
    title: "Commit history",
    area: "History & workflow",
    description: "Commits of a version and the versions it started from (newest first): #number, message, author, date, what changed (added / removed / changed / moved), version tags. Use the #numbers with compare_versions and restore_commit.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, limit: z.number().int().min(1).max(300).optional() }),
    run: async (x, env) => {
      const { a } = await readVersion(env, x.version);
      const h = await historyOf(a.version.id, x.limit ?? 50);
      const base = await baselineOf(a.version);
      const cur = clientDoc(parseDoc(a.version.doc));
      const dirty = base.doc ? diffDocs(base.doc, cur).changes.length : cur.pages.length ? 1 : 0;
      return [
        `${vName(a)}${["DRAFT", "CHANGES_REQUESTED"].includes(a.version.status) ? ` — ${dirty ? `${plural(dirty, "uncommitted change")} since ${base.label}` : "no uncommitted changes"}` : ""}`,
        ...h.map((e) =>
          e.type === "commit"
            ? `#${e.seq} ${e.createdAt.slice(0, 16).replace("T", " ")} ${e.author}: ${e.message}${e.kind !== "COMMIT" ? ` [${e.kind.toLowerCase()}]` : ""} (+${e.stats.added} −${e.stats.removed} ~${e.stats.changed} ↔${e.stats.moved}) v${e.versionLabel}${e.branch !== "main" ? ` ${e.branch}` : ""}${e.tags.length ? ` tag ${e.tags.map((t) => `v${t.label} ${t.status.toLowerCase()}`).join(", ")}` : ""}${e.head ? " (head)" : ""}`
            : `v${e.versionLabel} ${e.status.toLowerCase()} — ${e.summary || "no commits"} (${e.author}, ${e.createdAt.slice(0, 10)})`,
        ),
      ].join("\n");
    },
  }),
  tool({
    name: "compare_versions",
    title: "Compare versions or commits",
    area: "History & workflow",
    description: "What changed between a version and another version (\"DEMO-001@2\"), a commit (\"#12\"), or its last commit (default: the uncommitted changes): pages, components, wires, texts, symbols, settings — added, removed, changed (with the fields) and moved.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, with: z.string().optional().describe('Another version, a commit "#12", or "last_commit" (default)'), limit: z.number().int().min(1).max(2000).optional() }),
    run: async (x, env) => {
      const id = await resolveVersion(env.ctx, x.version);
      await flushLive(id);
      const a = await loadVersion(env.ctx, id);
      const cur = clientDoc(parseDoc(a.version.doc));
      const o = await otherDoc(env, a, x.with);
      const d = diffDocs(o.doc ?? { ...cur, pages: [], defs: {}, cables: [], terminalStrips: [], meta: { title: cur.meta.title, props: {} } }, cur);
      if (!d.changes.length) return `No differences between ${vName(a)} and ${o.label}`;
      const pageName = (pid?: string) => {
        const p = pid ? cur.pages.find((q) => q.id === pid) ?? o.doc?.pages.find((q) => q.id === pid) : undefined;
        return p ? ` (page ${cur.pages.includes(p) ? sheetNo(cur, p) : "removed"} "${p.title}")` : "";
      };
      const limit = x.limit ?? 400;
      return [
        `${vName(a)} compared with ${o.label}: ${d.summary.added} added, ${d.summary.removed} removed, ${d.summary.changed} changed, ${d.summary.moved} moved`,
        ...d.changes.slice(0, limit).map((c) => `${{ added: "+", removed: "−", changed: "~", moved: "↔" }[c.kind]} ${c.area} ${c.label}${pageName(c.pageId)}${c.details?.length ? `: ${c.details.slice(0, 8).join("; ")}${c.details.length > 8 ? " …" : ""}` : ""}`),
        ...(d.changes.length > limit ? [`… ${d.changes.length - limit} more`] : []),
      ].join("\n");
    },
  }),
  tool({
    name: "restore_commit",
    title: "Restore a commit",
    area: "History & workflow",
    description: "Make the working version exactly the drawing of a commit (\"#12\", from list_history) or of its last commit (\"last_commit\" = discard uncommitted changes). A normal change: undo reverts it; commit afterwards to record it.",
    access: "edit",
    annotations: { destructiveHint: true },
    input: z.object({ version, commit: z.string().describe('"#12" or "last_commit"') }),
    run: async (x, env) => {
      const { a } = await readVersion(env, x.version);
      const o = await otherDoc(env, a, x.commit === "last_commit" ? undefined : x.commit.startsWith("#") || /^\d+$/.test(x.commit) ? x.commit : (() => { throw new ToolError('Give a commit: "#12" or "last_commit"'); })());
      if (!o.doc) throw new ToolError("There is no commit to restore yet");
      const target = o.doc;
      return editDrawing(env, a.version.id, "restore_commit", (d) => {
        const t = structuredClone(target) as unknown as Record<string, unknown>;
        const dd = d as unknown as Record<string, unknown>;
        for (const k of Object.keys(dd)) if (!(k in t) && k !== "qet") delete dd[k];
        for (const [k, v] of Object.entries(t)) if (k !== "qet") dd[k] = v;
        return `Restored ${o.label} — commit_changes to record it`;
      });
    },
  }),
  tool({
    name: "submit_for_review",
    title: "Submit for review",
    area: "History & workflow",
    description: "Submit a working version for review — only when the person asks for it. Uncommitted changes are committed (commit_message), the version is frozen, the reviewers (names or emails of project members who may review) are asked to review in order (sequential) or together, with instructions and a due date. Approving, signing and releasing stay with people.",
    access: "edit",
    input: z.object({ version, reviewers: z.array(z.string()).min(1).max(30), instructions: z.string().max(10_000).optional(), due_date: z.string().optional().describe("YYYY-MM-DD"), sequential: z.boolean().optional(), commit_message: z.string().max(2000).optional() }),
    run: async (x, env) => {
      assertCanEdit(env, "submit versions");
      const id = await resolveVersion(env.ctx, x.version);
      const a = await loadVersion(env.ctx, id, { withDoc: false });
      const members = await db.user.findMany({ where: { disabled: false, projectMembers: { some: { projectId: a.project.id } } }, include: { memberships: { where: { workspaceId: env.ctx.workspace.id } } } });
      const mayReview = (u: (typeof members)[number]) => rolesAllow((u.memberships.length ? u.memberships.flatMap((m) => parseRoles(m.roles)) : u.isGuest ? ["GUEST"] : []) as Role[], "review.decide");
      const picked = x.reviewers.map((r) => {
        const q = r.trim().toLowerCase();
        const hits = members.filter((u) => u.email.toLowerCase() === q || u.name.toLowerCase() === q);
        const like = hits.length ? hits : members.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
        if (like.length !== 1) throw new ToolError(like.length ? `"${r}" matches ${like.map((u) => `${u.name} <${u.email}>`).join(", ")} — give the email` : `No project member "${r}". Members who may review: ${members.filter(mayReview).map((u) => `${u.name} <${u.email}>`).join(", ") || "none"}`);
        if (!mayReview(like[0])) throw new ToolError(`${like[0].name} may not review (no review permission)`);
        return like[0];
      });
      try {
        const r = await submitForReview(env.ctx, id, { reviewers: picked.map((u) => ({ userId: u.id })), dueDate: x.due_date ?? null, instructions: x.instructions ?? "", commitMessage: x.commit_message, sequential: x.sequential }, { via: via(env) });
        return `Submitted ${vName(a)} for review to ${picked.map((u) => u.name).join(", ")}${x.sequential ? " (in order)" : ""}${x.due_date ? `, due ${x.due_date}` : ""} — review ${r.reviewId}${r.aiReview ? "; the AI reviewer runs its first pass and posts findings as comments" : ""}. The version is frozen now.`;
      } catch (e) {
        if (e instanceof HttpError) throw new ToolError(e.message);
        throw e;
      }
    },
  }),
  tool({
    name: "recall_from_review",
    title: "Take a version back from review",
    area: "History & workflow",
    description: "Take a version that is in review (or approved, not signed) back to draft, with a reason — only when the person asks. Allowed for its author, the submitter or project owners (approved: owners and approvers).",
    access: "edit",
    input: z.object({ version, reason: z.string().min(1).max(2000) }),
    run: async (x, env) => {
      assertCanEdit(env, "change review status");
      const id = await resolveVersion(env.ctx, x.version);
      const a = await loadVersion(env.ctx, id, { withDoc: false });
      const manage = a.can("project.manage");
      if (a.version.status === "APPROVED") {
        if (!manage && !a.can("review.approve")) throw new ToolError("Only project owners and approvers can take back an approval");
      } else if (!manage) {
        const submitter = await db.review.findFirst({ where: { versionId: id, status: "OPEN", submittedById: env.ctx.user.id } });
        if (!a.can("project.edit") || (a.version.createdById !== env.ctx.user.id && !submitter)) throw new ToolError("Only the author, the submitter or project owners can recall a version from review");
      }
      try {
        await recallVersion(env.ctx, id, `${x.reason} (${via(env)})`);
      } catch (e) {
        if (e instanceof HttpError) throw new ToolError(e.message);
        throw e;
      }
      return `${a.project.number ? a.project.number + " " : ""}${a.project.name} v${a.version.label} is a draft again — it can be changed`;
    },
  }),

  /* ---------------------------------- reports and files ---------------------------------- */
  tool({
    name: "get_report",
    title: "Reports: BOM, wire list, terminal plan, cable list",
    area: "Reports & files",
    description: "A report as a table in the reply: bill of materials (grouping by part number, location or component), wire list (number, from, to, potential, colour, section, cable), terminal plan, cable list (core by core). export_file gives the same as CSV / Excel.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, report: z.enum(["bom", "wire_list", "terminal_plan", "cable_list"]), grouping: z.enum(["part", "location", "component"]).optional(), pages: z.array(page).optional() }),
    run: async (x, env) => {
      const { a, doc } = await readVersion(env, x.version);
      return `${vName(a)}\n${reportText(reportTable(doc, x.report as ReportKind, { grouping: x.grouping, pages: x.pages }))}`;
    },
  }),
  tool({
    name: "export_file",
    title: "Export a file",
    area: "Reports & files",
    description: `Make a file of a version and get a download link (valid 1 hour; works in a browser): ${FILE_FORMATS.join(", ")}. pdf: the drawing set (paper A3 default, A4, A2, A1, A0, fit); dxf / svg / png: one file per page (a zip for several); qet: QElectroTech project; volt: sealed .volt with comments and reviews; bom_xlsx / bom_csv; wire_list_csv; terminal_plan_csv; cable_list_csv. Requires the export permission.`,
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, format: z.enum(FILE_FORMATS), pages: z.array(page).optional(), paper: z.enum(["A4", "A3", "A2", "A1", "A0", "fit"]).optional() }),
    run: async (x, env) => {
      rateLimit(`mcp.export:${env.token.id}`, 20);
      const id = await resolveVersion(env.ctx, x.version);
      // make it once now: errors (permission, pages) show here, and the size is known
      const f = await makeFile(env.ctx, id, x.format as FileFormat, { pages: x.pages, paper: x.paper });
      const { token, expires } = signFileLink({ v: id, f: x.format as FileFormat, p: x.pages, paper: x.paper, t: env.token.id, u: env.ctx.user.id, w: env.ctx.workspace.id });
      const url = `${env.origin ?? ""}/api/mcp/files/${token}`;
      return {
        content: [
          { type: "resource_link", uri: url, name: f.filename, mimeType: f.type || fileMime(x.format as FileFormat), description: `${f.filename}, ${Math.max(1, Math.round(f.bytes.byteLength / 1024))} KB`, size: f.bytes.byteLength },
          { type: "text", text: `${f.filename} (${Math.max(1, Math.round(f.bytes.byteLength / 1024))} KB) — download: ${url}\nThe link works until ${expires.toISOString().slice(0, 16).replace("T", " ")} UTC; it stops working if this access token is revoked.` },
        ],
      };
    },
  }),
];
