import { notFound } from "next/navigation";
import { getCtx, requireCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { accessFor, canPublish, isAdmin, isApprover } from "@/lib/library/access";
import { ElementEditor } from "@/library-editor/editor/ElementEditor";
import { BlockDetail } from "@/library-editor/BlockDetail";
import type { LibUser } from "@/library-editor/types";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  const el = ctx ? await db.libraryElement.findUnique({ where: { id }, include: { library: true, shares: { select: { userId: true, canEdit: true } } }, omit: { content: true } }) : null;
  return { title: el && accessFor(ctx!, { ...el, content: "" }).canView ? `${el.name} · Library · Volt` : "Library · Volt" };
}

export default async function LibraryElementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const el = await db.libraryElement.findUnique({ where: { id }, include: { library: true, shares: { select: { userId: true, canEdit: true } } }, omit: { content: true } });
  if (!el || !accessFor(ctx, { ...el, content: "" }).canView) notFound();
  const user: LibUser = { id: ctx.user.id, name: ctx.user.name, isAdmin: isAdmin(ctx), isApprover: isApprover(ctx), canPublish: canPublish(ctx), requireApproval: ctx.settings.library.requireApprovalForOrg };
  return <div className="h-full">{el.kind === "BLOCK" ? <BlockDetail id={id} user={user} /> : <ElementEditor id={id} user={user} />}</div>;
}
