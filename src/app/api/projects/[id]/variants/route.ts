import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { docHash, parseDoc, reindexVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { flushLive } from "@/lib/live/hooks";
import { VARIANT_CODE, nextLineLabel, variantsOf } from "@/lib/variants";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const rows = await variantsOf(id);
  return { variants: rows.map((v) => ({ id: v.id, code: v.code, name: v.name, customer: v.customer, description: v.description, baseVersionId: v.baseVersionId, baseLabel: v.baseLabel, state: v.state, createdAt: v.createdAt.toISOString() })) };
});

/** versions a variant may branch from: anything but a draft in progress or an abandoned version */
const NOT_A_BASE = ["DRAFT", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN"];

const Body = z.object({
  baseVersionId: z.string().min(1),
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase().replace(/[\s-]+/g, "_"))
    .pipe(z.string().regex(VARIANT_CODE, "Code: 1–16 letters, digits or _ (e.g. ACME or ESTOP2)")),
  name: z.string().trim().min(1, "Name is required").max(120),
  customer: z.string().trim().max(200).default(""),
  description: z.string().max(10_000).default(""),
  summary: z.string().trim().max(500).optional(),
});

/** Create a variant from a main-line version and start its first version (a draft copy of the base). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.edit") && !can("project.manage")) throw new HttpError(403, "You cannot create variants in this project");
  if (project.state !== "ACTIVE") throw new HttpError(409, "Project is archived");
  await flushLive(b.baseVersionId);
  const base = await db.version.findUnique({ where: { id: b.baseVersionId } });
  if (!base || base.projectId !== id) throw new HttpError(404, "Base version not found");
  if (base.variantId) throw new HttpError(400, "Variants branch from a main-line version — continue this variant with a new version instead");
  if (NOT_A_BASE.includes(base.status)) throw new HttpError(409, `A ${base.status.toLowerCase().replace("_", " ")} version cannot be the base of a variant — use an approved, signed or released version`);
  if (await db.variant.findUnique({ where: { projectId_code: { projectId: id, code: b.code } } })) throw new HttpError(409, `Variant code ${b.code} is already used in this project`);
  const doc = parseDoc(base.doc);
  const { variant, version } = await db.$transaction(async (tx) => {
    const variant = await tx.variant.create({
      data: { projectId: id, code: b.code, name: b.name, customer: b.customer, description: b.description, baseVersionId: base.id, baseLabel: base.label, createdById: ctx.user.id },
    });
    const last = await tx.version.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" } });
    const seq = (last?.seq ?? 0) + 1;
    const label = await nextLineLabel(tx, project, variant.id, seq);
    const version = await tx.version.create({
      data: {
        projectId: id,
        variantId: variant.id,
        seq,
        label,
        parentId: base.id,
        status: "DRAFT",
        summary: b.summary || `${b.name}${b.customer ? ` for ${b.customer}` : ""} (from v${base.label})`,
        description: b.description,
        doc: base.doc,
        docHash: docHash(doc),
        createdById: ctx.user.id,
        baseCommitId: base.headCommitId,
      },
    });
    return { variant, version };
  });
  await db.project.update({ where: { id }, data: { updatedAt: new Date() } });
  await reindexVersion(version.id, id, doc);
  const a = { workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id };
  await audit({ ...a, type: "variant.create", data: { code: variant.code, name: variant.name, customer: variant.customer, base: base.label } });
  await audit({ ...a, versionId: version.id, type: "version.create", data: { label: version.label, parent: base.label, summary: version.summary, variant: variant.code } });
  const members = await db.projectMember.findMany({ where: { projectId: id }, select: { userId: true } });
  await notify(members.map((m) => m.userId).filter((u) => u !== ctx.user.id), {
    type: "variant.created",
    title: `New variant of ${project.name}: ${variant.name}`,
    body: `${variant.customer ? `For ${variant.customer}. ` : ""}Based on v${base.label}; first version ${version.label}.`,
    link: `/projects/${id}?tab=versions`,
    workspaceId: project.workspaceId,
  });
  return { variant: { id: variant.id, code: variant.code }, version: { id: version.id, label: version.label } };
});
