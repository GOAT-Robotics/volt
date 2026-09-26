import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db";
import { HttpError, loadProject, type Ctx } from "./session";
import { stableStringify } from "@/core/stable-json";
import type { Doc, VersionStatus } from "@/core/model";
import { EDITABLE_STATUSES } from "@/core/model";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const docHash = (doc: Doc) => sha256(stableStringify(doc));

/** Next version label for a scheme. */
export function nextLabel(scheme: string, prev: string | null, seq: number, custom?: string | null): string {
  switch (scheme) {
    case "DECIMAL": {
      if (!prev) return "0.1";
      const [a, b] = prev.split(".").map((x) => Number(x) || 0);
      return `${a}.${b + 1}`;
    }
    case "LETTER": {
      if (!prev) return "A";
      // A..Z, AA..AZ, ...
      const chars = prev.toUpperCase().split("");
      let i = chars.length - 1;
      while (i >= 0) {
        if (chars[i] !== "Z") {
          chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
          return chars.join("");
        }
        chars[i] = "A";
        i--;
      }
      return "A" + chars.join("");
    }
    case "CUSTOM":
      return (custom || "R{n}").replace("{n}", String(seq));
    default:
      return String(seq);
  }
}

/** Promote a DECIMAL scheme to the next major on release (0.3 → 1.0) — optional helper. */
export function majorLabel(prev: string) {
  const [a] = prev.split(".").map((x) => Number(x) || 0);
  return `${a + 1}.0`;
}

export type VersionAccess = {
  version: Awaited<ReturnType<typeof db.version.findUniqueOrThrow>>;
  project: Awaited<ReturnType<typeof loadProject>>["project"];
  can: Awaited<ReturnType<typeof loadProject>>["can"];
  editable: boolean;
  reason?: string;
  canComment: boolean;
  canExport: boolean;
};

export async function loadVersion(ctx: Ctx, versionId: string, opts: { withDoc?: boolean } = {}): Promise<VersionAccess> {
  const version = await db.version.findUnique({ where: { id: versionId }, ...(opts.withDoc === false ? { omit: { doc: true } } : {}) });
  if (!version) throw new HttpError(404, "Version not found");
  const { project, can } = await loadProject(ctx, version.projectId);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access to this project");
  const status = version.status as VersionStatus;
  let editable = EDITABLE_STATUSES.includes(status) && can("project.edit") && project.state === "ACTIVE";
  let reason: string | undefined;
  if (!EDITABLE_STATUSES.includes(status)) reason = status === "IN_REVIEW" ? "Frozen for review — start a new version to make changes" : `This version is ${status.toLowerCase().replace("_", " ")} and immutable`;
  else if (!can("project.edit")) reason = "You have view access only";
  else if (project.state !== "ACTIVE") ((reason = "Project is archived"), (editable = false));
  const isGuest = ctx.user.isGuest || (ctx.roles.length === 1 && ctx.roles[0] === "GUEST");
  const canExport = isGuest ? ctx.settings.exports.guestCanExport : can("project.export") && (can("project.edit") || ctx.settings.exports.viewerCanExport);
  return { version: version as VersionAccess["version"], project, can, editable, reason, canComment: can("review.comment"), canExport };
}

export function assertEditable(a: VersionAccess) {
  if (!a.editable) throw new HttpError(409, a.reason ?? "Version is not editable", "NOT_EDITABLE");
}

/** Rebuild search rows for a version (components, pins, labels, pages, wires). */
export async function reindexVersion(versionId: string, projectId: string, doc: Doc) {
  const rows: { projectId: string; versionId: string; pageId: string | null; kind: string; refId: string | null; text: string }[] = [];
  for (const p of doc.pages) {
    rows.push({ projectId, versionId, pageId: p.id, kind: "PAGE", refId: p.id, text: p.title });
    for (const e of p.elements) {
      const def = doc.defs[e.defId];
      if (!def || def.name === "volt_junction") continue;
      const label = e.info.label ?? "";
      rows.push({ projectId, versionId, pageId: p.id, kind: "ELEMENT", refId: e.id, text: `${label} ${def.name} ${Object.values(e.info).filter((v) => v && v !== label).join(" ")}`.trim() });
      for (const pin of def.pins) if (pin.name || pin.number) rows.push({ projectId, versionId, pageId: p.id, kind: "PIN", refId: e.id, text: `${label}:${pin.number} ${pin.name}`.trim() });
    }
    for (const w of p.wires) if (w.label) rows.push({ projectId, versionId, pageId: p.id, kind: "WIRE", refId: w.id, text: w.label });
    for (const t of p.texts) if (t.text.trim()) rows.push({ projectId, versionId, pageId: p.id, kind: "LABEL", refId: t.id, text: t.text.slice(0, 200) });
  }
  await db.$transaction([db.searchEntry.deleteMany({ where: { versionId } }), ...chunk(rows, 400).map((c) => db.searchEntry.createMany({ data: c }))]);
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export function parseDoc(s: string): Doc {
  return JSON.parse(s) as Doc;
}
