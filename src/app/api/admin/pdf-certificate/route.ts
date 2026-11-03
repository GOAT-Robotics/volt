import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { assertAdmin, fileResponse } from "@/lib/access";
import { audit } from "@/lib/audit";
import { loadPdfCert, publicInfo, saveUploadedP12 } from "@/lib/signing/pdf-cert";

export const runtime = "nodejs";

/** The certificate that signs release PDFs; ?download=cer gives the public certificate for IT / trust lists. */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const cert = loadPdfCert(ctx.settings.branding.name || ctx.workspace.name);
  if (new URL(req.url).searchParams.get("download") === "cer") return fileResponse(Buffer.from(cert.certPem), { filename: "volt-document-signing.cer", type: "application/pkix-cert" });
  return { certificate: publicInfo(cert), fromEnvironment: !!process.env.PDF_SIGNING_P12 };
});

/** Upload a CA-issued certificate (.p12 / .pfx with its password) to sign release PDFs from now on. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const fd = await req.formData();
  const file = fd.get("file");
  const password = String(fd.get("password") ?? "");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a .p12 or .pfx file");
  if (file.size > 200_000) throw new HttpError(400, "That file is too large for a certificate");
  let info;
  try {
    info = saveUploadedP12(Buffer.from(await file.arrayBuffer()), password);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.pdf_certificate", data: { subject: info.subject, issuer: info.issuer, fingerprint: info.fingerprint, notAfter: info.notAfter } });
  return { certificate: info };
});
