import "server-only";
import { after } from "next/server";
import { createHash } from "node:crypto";
import { db } from "../db";
import { audit } from "../audit";
import { baseUrl } from "../access";
import { HttpError } from "../session";
import { parseSettings } from "../settings";
import { buildReleasePdf } from "./release";
import { loadPdfCert, publicInfo } from "./pdf-cert";
import { signPdf } from "./pdf-sign";

/**
 * The release PDF of a released version — drawing, approval & signature record — digitally signed
 * (PAdES, adbe.pkcs7.detached) with the organization's certificate. Made once, at release, and
 * stored (Attachment ownerType RELEASE), so everyone downloads the same signed bytes.
 */

const inflight = new Map<string, Promise<SignedRelease>>();
export type SignedRelease = { bytes: Buffer; filename: string; sha256: string };

/** The stored signed release PDF of a released version; made now if it is missing. */
export async function signedReleasePdf(versionId: string): Promise<SignedRelease> {
  const have = await db.attachment.findFirst({ where: { ownerType: "RELEASE", ownerId: versionId, mime: "application/pdf" }, orderBy: { createdAt: "desc" } });
  if (have) return { bytes: Buffer.from(have.data), filename: have.filename, sha256: have.sha256 };
  let p = inflight.get(versionId);
  if (!p) {
    p = make(versionId).finally(() => inflight.delete(versionId));
    inflight.set(versionId, p);
  }
  return p;
}

async function make(versionId: string): Promise<SignedRelease> {
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: { include: { workspace: true } } } });
  if (!v) throw new HttpError(404, "Version not found");
  if (!v.releasedAt) throw new HttpError(409, "Only released versions have a signed release PDF");
  const settings = parseSettings(v.project.workspace.settings);
  const org = settings.branding.name || v.project.workspace.name;
  const cert = loadPdfCert(org);
  const site = baseUrl();
  const { bytes, filename } = await buildReleasePdf(versionId, site, { digital: publicInfo(cert) });
  const signed = await signPdf(bytes, cert, {
    reason: `Released drawing ${v.project.name} v${v.label}`,
    name: org,
    location: settings.branding.address.split("\n")[0]?.trim() || org,
    contactInfo: site || settings.branding.url || "",
  });
  const sha256 = createHash("sha256").update(signed).digest("hex");
  const name = filename.replace(/_release\.pdf$/, "_release_signed.pdf");
  await db.attachment.create({ data: { projectId: v.projectId, ownerType: "RELEASE", ownerId: v.id, filename: name, mime: "application/pdf", size: signed.byteLength, sha256, data: new Uint8Array(signed), userId: v.createdById } });
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, type: "release.pdf_signed", data: { label: v.label, sha256, certificate: cert.fingerprint, subject: cert.subject } });
  return { bytes: signed, filename: name, sha256 };
}

/** Makes the signed PDF in the background after the request that released the version. */
export function scheduleSignedRelease(versionId: string) {
  const run = () =>
    signedReleasePdf(versionId).then(
      () => undefined,
      (e) => console.error(`[release] signing the release PDF of ${versionId} failed:`, e),
    );
  try {
    after(run);
  } catch {
    void run();
  }
}
