/**
 * Version lines. A project has a main line (v1, v2, v3 …) and any number of variants: customer or
 * configuration specific lines branched from a main-line version (v2 + extra emergency stop for
 * ACME → 2-ACME.1, 2-ACME.2 …). Every line has its own working version, reviews, signatures and
 * release; releasing a version supersedes only the earlier release of the same line.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { HttpError } from "./session";
import { nextLabel } from "./versioning";

type Tx = Prisma.TransactionClient;

export const VARIANT_CODE = /^[A-Z0-9][A-Z0-9_]{0,15}$/;

/** where clause for the versions of one line (main line: variantId null) */
export const lineWhere = (projectId: string, variantId: string | null) => ({ projectId, variantId });

/** label of the next version in a line */
export async function nextLineLabel(tx: Tx, project: { id: string; versionScheme: string; customScheme: string | null }, variantId: string | null, seq: number): Promise<string> {
  if (!variantId) {
    const last = await tx.version.findFirst({ where: { projectId: project.id, variantId: null }, orderBy: { seq: "desc" } });
    // main-line numbering ignores variant versions (they share the project's sequence numbers)
    const count = await tx.version.count({ where: { projectId: project.id, variantId: null } });
    const lastN = last && /^\d+$/.test(last.label) ? Number(last.label) : 0;
    const mainSeq = Math.max(count, lastN) + 1;
    const label = nextLabel(project.versionScheme, last?.label ?? null, mainSeq, project.customScheme);
    const clash = await tx.version.findFirst({ where: { projectId: project.id, label } });
    return clash ? `${label}-${seq}` : label;
  }
  const v = await tx.variant.findUnique({ where: { id: variantId } });
  if (!v) throw new HttpError(404, "Variant not found");
  const prefix = `${v.baseLabel}-${v.code}.`;
  const rows = await tx.version.findMany({ where: { variantId }, select: { label: true } });
  const n = Math.max(0, ...rows.map((r) => (r.label.startsWith(prefix) ? Number(r.label.slice(prefix.length)) || 0 : 0))) + 1;
  let label = `${prefix}${n}`;
  if (await tx.version.findFirst({ where: { projectId: project.id, label } })) label = `${label}-${seq}`;
  return label;
}

export async function variantsOf(projectId: string) {
  return db.variant.findMany({ where: { projectId }, orderBy: [{ state: "asc" }, { createdAt: "asc" }] });
}
