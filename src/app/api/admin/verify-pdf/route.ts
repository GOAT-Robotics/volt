import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { assertAdmin } from "@/lib/access";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { copyInfo, verifyUpload } from "@/lib/signing/release-signed";
import { COPY_CODE } from "@/lib/signing/pdf-sign";

export const runtime = "nodejs";

/** ?code=VLT-XXXX-XXXX — the copy printed on a paper page. Administrators only. */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = code.match(COPY_CODE);
  if (!m) throw new HttpError(400, "A copy code looks like VLT-7KQ2-9XHM");
  const copy = await copyInfo({ code: m[0] }, ctx.workspace.id);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "release.verify", data: { code: m[0], found: !!copy, by: "code" } });
  return { copy };
});

/** Upload a PDF: who downloaded this copy, when, and whether the file was changed since. Administrators only. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  rateLimit(`verify:${ctx.user.id}`, 30);
  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a PDF file");
  if (file.size > 200 * 1024 * 1024) throw new HttpError(400, "That file is too large");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) throw new HttpError(400, "That is not a PDF file");
  const r = await verifyUpload(bytes, ctx.workspace.id);
  await audit({ workspaceId: ctx.workspace.id, projectId: r.copy?.project?.id ?? null, versionId: r.copy?.version?.id ?? null, actorId: ctx.user.id, type: "release.verify", data: { file: file.name, sha256: r.fileSha256, match: r.match, code: r.copy?.code ?? null } });
  return r;
});
