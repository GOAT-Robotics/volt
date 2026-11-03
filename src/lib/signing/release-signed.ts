import "server-only";
import { after } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { db } from "../db";
import { audit } from "../audit";
import { baseUrl } from "../access";
import { HttpError, type Ctx } from "../session";
import { parseSettings } from "../settings";
import { buildReleasePdf } from "./release";
import { loadPdfCert, publicInfo } from "./pdf-cert";
import { checkPdfSignature, COPY_CODE, signPdf, type PdfSignatureCheck } from "./pdf-sign";

/**
 * The release PDF of a released version — drawing + approval & signature record — handed out as
 * tracked, digitally signed copies:
 *
 * - the release PDF itself is built once, at release, and stored (Attachment ownerType RELEASE_PDF,
 *   unsigned, never listed or exported);
 * - every download is its own copy: a code (VLT-XXXX-XXXX) is made for it, every page gets the green
 *   APPROVED & RELEASED stamp with the copy code, who downloaded it and when, the code goes into the
 *   PDF metadata, and the copy is digitally signed (PAdES) with the organization's certificate;
 * - the copy is recorded (ReleaseCopy: who, when, IP, SHA-256 of the file), so a file that turns up
 *   later — or a printed page with its code — is traced on Administration → Verify a PDF.
 */

const BASE = "RELEASE_PDF";
const inflight = new Map<string, Promise<{ bytes: Buffer; filename: string }>>();

/** The stored release PDF (unsigned, no stamp) of a released version; made now if it is missing. */
async function releaseBase(versionId: string): Promise<{ bytes: Buffer; filename: string }> {
  const have = await db.attachment.findFirst({ where: { ownerType: BASE, ownerId: versionId }, orderBy: { createdAt: "desc" } });
  if (have) return { bytes: Buffer.from(have.data), filename: have.filename };
  let p = inflight.get(versionId);
  if (!p) {
    p = makeBase(versionId).finally(() => inflight.delete(versionId));
    inflight.set(versionId, p);
  }
  return p;
}

async function makeBase(versionId: string) {
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: { include: { workspace: true } } } });
  if (!v) throw new HttpError(404, "Version not found");
  if (!v.releasedAt) throw new HttpError(409, "Only released versions have a signed release PDF");
  const settings = parseSettings(v.project.workspace.settings);
  const cert = loadPdfCert(settings.branding.name || v.project.workspace.name);
  const { bytes, filename } = await buildReleasePdf(versionId, baseUrl(), { digital: publicInfo(cert) });
  const data = Buffer.from(bytes);
  await db.attachment.create({
    data: { projectId: v.projectId, ownerType: BASE, ownerId: v.id, filename, mime: "application/pdf", size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), data: new Uint8Array(data), userId: v.createdById },
  });
  return { bytes: data, filename };
}

/** Builds the release PDF in the background after the request that released the version. */
export function scheduleSignedRelease(versionId: string) {
  const run = () =>
    releaseBase(versionId).then(
      () => undefined,
      (e) => console.error(`[release] building the release PDF of ${versionId} failed:`, e),
    );
  try {
    after(run);
  } catch {
    void run();
  }
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newCode() {
  const b = randomBytes(8);
  const c = [...b].map((x) => ALPHABET[x % 32]).join("");
  return `VLT-${c.slice(0, 4)}-${c.slice(4)}`;
}

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** who approved (and signed) the version, for the stamp */
async function approverNames(versionId: string): Promise<string[]> {
  const sigs = await db.signature.findMany({ where: { versionId, status: "SIGNED" }, orderBy: { signedAt: "asc" }, select: { signatoryId: true } });
  let ids = sigs.map((s) => s.signatoryId);
  if (!ids.length) {
    const r = await db.review.findFirst({ where: { versionId, status: "APPROVED" }, orderBy: { createdAt: "desc" }, include: { assignments: true } });
    ids = (r?.assignments ?? []).filter((a) => a.decision === "APPROVED" && a.decidedById).map((a) => a.decidedById!);
  }
  ids = [...new Set(ids)];
  const users = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return ids.map((id) => users.get(id) ?? "Unknown");
}

/** A new tracked, stamped and signed copy of a released version's PDF for the person downloading it. */
export async function releaseCopy(ctx: Ctx, versionId: string, meta: { ip: string | null; userAgent: string }) {
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: { include: { workspace: true } } } });
  if (!v) throw new HttpError(404, "Version not found");
  if (!v.releasedAt) throw new HttpError(409, "Only released versions have a signed release PDF");
  const base = await releaseBase(versionId);
  const settings = parseSettings(v.project.workspace.settings);
  const org = settings.branding.name || v.project.workspace.name;
  const cert = loadPdfCert(org);
  let code = newCode();
  while (await db.releaseCopy.findUnique({ where: { code }, select: { id: true } })) code = newCode();
  const now = new Date();
  const signed = await signPdf(
    base.bytes,
    cert,
    { reason: `Released drawing ${v.project.name} v${v.label} - copy ${code}`, name: org, location: settings.branding.address.split("\n")[0]?.trim() || org, contactInfo: baseUrl() || settings.branding.url || "" },
    { stamp: { project: v.project.name, label: v.label, released: day(v.releasedAt), approvers: await approverNames(v.id), copy: { code, by: ctx.user.name || ctx.user.email, at: stamp(now) } } },
  );
  const sha256 = createHash("sha256").update(signed).digest("hex");
  await db.releaseCopy.create({
    data: { code, workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, userId: ctx.user.id, sha256, size: signed.byteLength, ip: meta.ip, userAgent: meta.userAgent.slice(0, 400), createdAt: now },
  });
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "release.download", data: { label: v.label, code, sha256 } });
  return { bytes: signed, filename: base.filename.replace(/_release\.pdf$/, `_release_${code}.pdf`), code, sha256 };
}

export type CopyInfo = {
  code: string;
  at: string;
  ip: string | null;
  userAgent: string;
  sha256: string;
  by: { id: string; name: string; email: string } | null;
  project: { id: string; name: string; number: string | null } | null;
  version: { id: string; label: string; status: string } | null;
};

export async function copyInfo(where: { code: string } | { sha256: string }, workspaceId: string): Promise<CopyInfo | null> {
  const c = await db.releaseCopy.findFirst({ where: { ...where, workspaceId } });
  if (!c) return null;
  const [u, p, v] = await Promise.all([
    db.user.findUnique({ where: { id: c.userId }, select: { id: true, name: true, email: true } }),
    db.project.findUnique({ where: { id: c.projectId }, select: { id: true, name: true, number: true } }),
    db.version.findUnique({ where: { id: c.versionId }, select: { id: true, label: true, status: true } }),
  ]);
  return { code: c.code, at: c.createdAt.toISOString(), ip: c.ip, userAgent: c.userAgent, sha256: c.sha256, by: u, project: p, version: v };
}

export type VerifyResult = {
  /** exact: the very file that was downloaded · code: the copy code was found, but the file differs · none */
  match: "exact" | "code" | "none";
  fileSha256: string;
  copy: CopyInfo | null;
  signature: PdfSignatureCheck & { ours: boolean };
};

/** Identifies an uploaded PDF: by its SHA-256, else by the copy code in its metadata or text. */
export async function verifyUpload(file: Buffer, workspaceId: string): Promise<VerifyResult> {
  const fileSha256 = createHash("sha256").update(file).digest("hex");
  const sig = checkPdfSignature(file);
  let ours = false;
  try {
    ours = !!sig.certFingerprint && sig.certFingerprint === loadPdfCert().fingerprint;
  } catch {}
  const exact = await copyInfo({ sha256: fileSha256 }, workspaceId);
  if (exact) return { match: "exact", fileSha256, copy: exact, signature: { ...sig, ours } };
  // a changed or re-saved file: look for the copy code (metadata, then anywhere in the file)
  let code = file.toString("latin1").match(COPY_CODE)?.[0] ?? null;
  if (!code) {
    try {
      const doc = await PDFDocument.load(file, { ignoreEncryption: true, updateMetadata: false });
      code = `${doc.getKeywords() ?? ""} ${doc.getSubject() ?? ""}`.match(COPY_CODE)?.[0] ?? null;
    } catch {}
  }
  const byCode = code ? await copyInfo({ code }, workspaceId) : null;
  return { match: byCode ? "code" : "none", fileSha256, copy: byCode, signature: { ...sig, ours } };
}
