import { z } from "zod";
import { rateLimit } from "@/lib/ratelimit";
import { formData, route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { importAsProject, mergeVolt, parseVoltUpload } from "@/lib/voltfile/import";
import { MAX_VOLT_FILE } from "@/lib/voltfile/format";

export const runtime = "nodejs";

const Targets = z.array(z.string().min(1).max(120)).min(1).max(100);

/**
 * Upload a .volt file.
 *  - mode=new: open it as a new project (name, number, folderId, tags).
 *  - mode=merge: bring the comments and review decisions of a reviewed copy back into the
 *    versions it was made from (targets: JSON array of version ids, from /api/volt/inspect).
 */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`volt.import:${ctx.user.id}`, 10);
  const fd = await formData(req, MAX_VOLT_FILE + 1024 * 1024, "File");
  const p = await parseVoltUpload(fd.get("file"));
  const mode = String(fd.get("mode") ?? "new");
  if (mode === "merge") {
    let targets: string[];
    try {
      targets = Targets.parse(JSON.parse(String(fd.get("targets") ?? "[]")));
    } catch {
      throw new HttpError(400, "Choose the versions to merge into");
    }
    return mergeVolt(ctx, p, targets);
  }
  if (mode !== "new") throw new HttpError(400, "Unknown import mode");
  const name = String(fd.get("name") ?? "").trim().slice(0, 300) || p.bundle.project.name;
  const number = String(fd.get("number") ?? "").trim().slice(0, 100) || null;
  const folderId = String(fd.get("folderId") ?? "") || null;
  let tags: string[] = [];
  try {
    const raw: unknown = JSON.parse(String(fd.get("tags") ?? "[]"));
    if (Array.isArray(raw)) tags = raw.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  } catch {}
  return importAsProject(ctx, p, { name, number, folderId, tags });
});
