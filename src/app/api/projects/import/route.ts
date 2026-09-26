import { route } from "@/lib/api";
import { apiCtx, assertCan, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/versioning";
import { createProjectRecord } from "@/lib/projects";
import { importQet } from "@/core/qet";

export const runtime = "nodejs";
const MAX = 50 * 1024 * 1024;

/** Import a QElectroTech .qet project: re-parsed server-side, original bytes + compatibility report preserved. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertCan(ctx, "project.create");
  if (Number(req.headers.get("content-length") ?? 0) > MAX + 1024 * 1024) throw new HttpError(413, "File exceeds the 50 MB limit");
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart form data");
  }
  const file = fd.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
  if (file.size > MAX) throw new HttpError(413, "File exceeds the 50 MB limit");
  const filename = (file.name || "project.qet").split(/[\\/]/).pop()!.slice(0, 200);
  if (!/\.qet$/i.test(filename)) throw new HttpError(415, "Only QElectroTech .qet project files can be imported");
  const bytes = Buffer.from(await file.arrayBuffer());
  const xml = bytes.toString("utf8");
  let parsed;
  try {
    parsed = importQet(xml, filename);
  } catch (e) {
    throw new HttpError(422, `This file could not be read as a QElectroTech project: ${(e as Error).message}`);
  }
  const { doc, report } = parsed;
  const name = String(fd.get("name") ?? "").trim() || doc.meta.title || filename.replace(/\.qet$/i, "");
  const number = String(fd.get("number") ?? "").trim() || null;
  const folderId = String(fd.get("folderId") ?? "") || null;
  let tags: string[] = [];
  try {
    tags = JSON.parse(String(fd.get("tags") ?? "[]"));
    if (!Array.isArray(tags)) tags = [];
    tags = tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  } catch {}
  if (folderId && !(await db.folder.findFirst({ where: { id: folderId, workspaceId: ctx.workspace.id } }))) throw new HttpError(400, "Folder not found");
  if (number && (await db.project.findFirst({ where: { workspaceId: ctx.workspace.id, number } }))) throw new HttpError(409, `Project number ${number} is already used`);
  doc.meta.title = name;
  const { project, version } = await createProjectRecord({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    name,
    number,
    folderId,
    tags,
    description: `Imported from ${filename}`,
    doc,
    summary: `Imported from ${filename}`,
  });
  const hash = sha256(bytes);
  const rec = await db.importRecord.create({ data: { projectId: project.id, versionId: version.id, filename, sha256: hash, original: bytes, report: JSON.stringify(report), userId: ctx.user.id } });
  const counts = report.items.reduce<Record<string, number>>((m, i) => ((m[i.level] = (m[i.level] ?? 0) + 1), m), {});
  await audit({ workspaceId: ctx.workspace.id, projectId: project.id, versionId: version.id, actorId: ctx.user.id, type: "project.import", data: { filename, sha256: hash, size: bytes.byteLength, pages: report.pageCount, elements: report.elementCount, wires: report.wireCount, report: counts } });
  return { id: project.id, versionId: version.id, importId: rec.id, label: version.label };
});
