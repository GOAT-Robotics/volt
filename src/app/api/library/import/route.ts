import { rateLimit } from "@/lib/ratelimit";
import { formData, route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, isApprover, personalLibrary, writableLibrary } from "@/lib/library/access";
import { z } from "zod";
import { importElmts, MAX_IMPORT_BYTES, type ImportEntry, type ImportOverride } from "@/lib/library/store";

const OverridesSchema = z.record(
  z.string(),
  z.object({
    exclude: z.boolean().optional(),
    name: z.string().max(200).optional(),
    category: z.string().max(300).optional(),
    prefix: z.string().max(12).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    info: z.record(z.string().max(60), z.string().max(500)).optional(),
  }),
);
import { normCategory } from "@/lib/library/elmt-tools";

export const runtime = "nodejs";

/**
 * multipart: files (.elmt / .zip; the filename may carry a relative path → category)
 * dryRun=1 → { preview, errors } (the import review: parsed details, duplicates; nothing written)
 * overrides: JSON { [path]: { exclude, name, category, prefix, description, tags, info } } from the review
 * optional: libraryId | newLibrary (name) + license / attribution / source / description,
 *           category (prefix for all imported categories), duplicates = skip | copy | update
 * → { created, skipped, updated, errors, ids, libraryId }
 */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`library.import:${ctx.user.id}`, 30);
  assertMember(ctx);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_IMPORT_BYTES) throw new HttpError(413, "Upload too large (max 80 MB)");
  const fd = await formData(req, MAX_IMPORT_BYTES, "Upload");
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
  const dryRun = str("dryRun") === "1";
  let overrides: Record<string, ImportOverride> | undefined;
  if (str("overrides")) {
    try {
      overrides = OverridesSchema.parse(JSON.parse(str("overrides")!));
    } catch {
      throw new HttpError(400, "Invalid element details");
    }
  }
  let library;
  const newName = str("newLibrary");
  if (dryRun) library = str("libraryId") && !newName ? await writableLibrary(ctx, str("libraryId")) : await personalLibrary(ctx);
  else if (newName) {
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
    overrides,
    dryRun,
    requireApprovalForOrg: ctx.settings.library.requireApprovalForOrg,
    isApprover: isApprover(ctx),
  });
  if (dryRun) return { preview: res.preview ?? [], errors: res.errors.slice(0, 200) };
  await audit({
    workspaceId: ctx.workspace.id,
    actorId: ctx.user.id,
    type: "library.import",
    data: { library: library.name, libraryId: library.id, files: files.map((f) => f.path).slice(0, 50), created: res.created, skipped: res.skipped, updated: res.updated, errors: res.errors.length },
  });
  return { created: res.created, skipped: res.skipped, updated: res.updated, errors: res.errors.slice(0, 200), ids: res.ids, libraryId: library.id };
});
