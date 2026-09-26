import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, personalLibrary, writableLibrary } from "@/lib/library/access";
import { importElmts, MAX_IMPORT_BYTES, type ImportEntry } from "@/lib/library/store";
import { normCategory } from "@/lib/library/elmt-tools";

export const runtime = "nodejs";

/**
 * multipart: files (.elmt / .zip; the filename may carry a relative path → category)
 * optional: libraryId | newLibrary (name) + license / attribution / source / description,
 *           category (prefix for all imported categories), duplicates = skip | copy | update
 * → { created, skipped, updated, errors, ids, libraryId }
 */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_IMPORT_BYTES) throw new HttpError(413, "Upload too large (max 80 MB)");
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart/form-data");
  }
  const files: ImportEntry[] = [];
  let total = 0;
  for (const v of fd.getAll("files")) {
    if (typeof v === "string") continue;
    const f = v as File;
    total += f.size;
    if (total > MAX_IMPORT_BYTES) throw new HttpError(413, "Upload too large (max 80 MB)");
    files.push({ path: f.name || "element.elmt", data: new Uint8Array(await f.arrayBuffer()) });
  }
  if (!files.length) throw new HttpError(400, "No files received");
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  let library;
  const newName = str("newLibrary");
  if (newName) {
    library = await db.library.create({
      data: {
        workspaceId: ctx.workspace.id,
        name: newName.slice(0, 200),
        description: str("description") ?? "",
        scope: "PERSONAL",
        ownerId: ctx.user.id,
        license: str("license"),
        attribution: str("attribution"),
        source: str("source"),
      },
    });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.lib.create", data: { id: library.id, name: library.name, license: library.license } });
  } else library = str("libraryId") ? await writableLibrary(ctx, str("libraryId")) : await personalLibrary(ctx);
  const dup = str("duplicates");
  const res = await importElmts(files, {
    library,
    ownerId: ctx.user.id,
    visibility: "PRIVATE",
    status: "DRAFT",
    onDuplicate: dup === "copy" || dup === "update" ? dup : "skip",
    categoryPrefix: normCategory(str("category") ?? ""),
  });
  await audit({
    workspaceId: ctx.workspace.id,
    actorId: ctx.user.id,
    type: "library.import",
    data: { library: library.name, libraryId: library.id, files: files.map((f) => f.path).slice(0, 50), created: res.created, skipped: res.skipped, updated: res.updated, errors: res.errors.length },
  });
  return { created: res.created, skipped: res.skipped, updated: res.updated, errors: res.errors.slice(0, 200), ids: res.ids, libraryId: library.id };
});
