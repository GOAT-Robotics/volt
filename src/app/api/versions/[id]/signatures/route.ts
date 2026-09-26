import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { loadVersion } from "@/lib/versioning";
import { baseUrl } from "@/lib/access";
import { eligibleSignatories, requestSignatures } from "@/lib/signing/service";
import { applyExpiry } from "@/lib/workflow";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  await applyExpiry(id);
  const rows = await db.signature.findMany({ where: { versionId: id }, orderBy: [{ createdAt: "asc" }, { order: "asc" }] });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.signatoryId, r.requestedById]))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
  return {
    signatures: rows.map((s) => ({
      id: s.id,
      status: s.status,
      order: s.order,
      purpose: s.purpose,
      signatory: users.get(s.signatoryId) ?? null,
      requestedBy: users.get(s.requestedById)?.name ?? "",
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
      signedAt: s.signedAt?.toISOString() ?? null,
      declineReason: s.declineReason,
      docHash: s.docHash,
      pdfHash: s.pdfHash,
      provider: s.provider,
      evidence: J.parse(s.evidence, null),
      seal: s.seal,
    })),
    eligible: a.can("project.manage") ? await eligibleSignatories(a.project.workspaceId, a.project.id) : [],
  };
});

const Body = z.object({ signatoryIds: z.array(z.string().min(1)).min(1).max(20), purpose: z.string().trim().min(1, "Purpose is required").max(500) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.can("project.manage")) throw new HttpError(403, "Only project owners can request signatures");
  const ids = await requestSignatures(ctx, id, { signatoryIds: b.signatoryIds, purpose: b.purpose, baseUrl: baseUrl(req) });
  return { ids };
});
