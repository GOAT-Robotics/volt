import type { Metadata } from "next";
import { requireCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/access";
import { PageHeader } from "@/components/shell/AppShell";
import { Forbidden } from "@/components/volt/common";
import { VerifyView, type CopyRow } from "./VerifyView";

export const metadata: Metadata = { title: "Verify a PDF" };

/** Administrators: trace a released PDF back to the person who downloaded it. */
export default async function VerifyPage() {
  const ctx = await requireCtx();
  if (!isAdmin(ctx)) return <Forbidden title="Administrators only">Verifying release PDFs is available to workspace administrators.</Forbidden>;
  const copies = await db.releaseCopy.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { createdAt: "desc" }, take: 200 });
  const [users, projects, versions] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...new Set(copies.map((c) => c.userId))] } }, select: { id: true, name: true, email: true } }),
    db.project.findMany({ where: { id: { in: [...new Set(copies.map((c) => c.projectId))] } }, select: { id: true, name: true, number: true } }),
    db.version.findMany({ where: { id: { in: [...new Set(copies.map((c) => c.versionId))] } }, select: { id: true, label: true, status: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const p = new Map(projects.map((x) => [x.id, x]));
  const v = new Map(versions.map((x) => [x.id, x]));
  const rows: CopyRow[] = copies.map((c) => ({
    code: c.code,
    at: c.createdAt.toISOString(),
    ip: c.ip,
    by: u.get(c.userId) ?? null,
    project: p.get(c.projectId) ?? null,
    version: v.get(c.versionId) ?? null,
  }));
  return (
    <>
      <PageHeader
        title="Verify a PDF"
        description="Every download of a released drawing is its own signed copy, with a copy code on each page. Upload a file — or type the code from a printed page — to see who downloaded it, when, and whether it was changed."
      />
      <VerifyView recent={rows} />
    </>
  );
}
