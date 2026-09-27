import type { Metadata } from "next";
import { requireCtx, can } from "@/lib/session";
import { db, J } from "@/lib/db";
import { projectScope, isGuestCtx } from "@/lib/access";
import { parseTemplateContent } from "@/lib/templates";
import { ProjectsView, type ProjectRow, type FolderRow } from "./ProjectsView";

export const metadata: Metadata = { title: "Projects" };

type SP = { folder?: string; tag?: string; state?: string; q?: string; view?: string };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requireCtx();
  const state = sp.state === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  const view = sp.view === "favorites" || sp.view === "recent" ? sp.view : "all";
  const q = (sp.q ?? "").trim();

  const [all, folders, favs, templates] = await Promise.all([
    db.project.findMany({
      where: { AND: [projectScope(ctx), { state }] },
      orderBy: { updatedAt: "desc" },
      include: { versions: { orderBy: { seq: "desc" }, take: 3, omit: { doc: true } }, _count: { select: { versions: true } } },
    }),
    isGuestCtx(ctx) ? [] : db.folder.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { name: "asc" } }),
    db.favorite.findMany({ where: { userId: ctx.user.id }, select: { projectId: true } }),
    can(ctx, "project.create") ? db.projectTemplate.findMany({ where: { workspaceId: ctx.workspace.id, status: "APPROVED" }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }) : [],
  ]);
  const favSet = new Set(favs.map((f) => f.projectId));
  const tags = [...new Set(all.flatMap((p) => J.parse<string[]>(p.tags, [])))].sort((a, b) => a.localeCompare(b));

  // descendant folders are included when a folder is selected
  const childrenOf = new Map<string | null, string[]>();
  for (const f of folders) childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);
  const inFolder = new Set<string>();
  if (sp.folder) {
    const stack = [sp.folder];
    while (stack.length) {
      const id = stack.pop()!;
      inFolder.add(id);
      stack.push(...(childrenOf.get(id) ?? []));
    }
  }
  const ql = q.toLowerCase();
  let list = all.filter((p) => {
    const t = J.parse<string[]>(p.tags, []);
    if (sp.folder && (!p.folderId || !inFolder.has(p.folderId))) return false;
    if (sp.tag && !t.includes(sp.tag)) return false;
    if (view === "favorites" && !favSet.has(p.id)) return false;
    if (ql && !`${p.name} ${p.number ?? ""} ${p.description} ${t.join(" ")}`.toLowerCase().includes(ql)) return false;
    return true;
  });
  if (view === "recent") list = list.slice(0, 12);

  const working = (v: { status: string }) => v.status === "DRAFT" || v.status === "CHANGES_REQUESTED";
  const rows: ProjectRow[] = list.map((p) => {
    const latest = p.versions[0];
    const released = p.versions.find((v) => v.status === "RELEASED");
    const open = p.versions.find(working);
    return {
      id: p.id,
      name: p.name,
      number: p.number,
      description: p.description,
      tags: J.parse<string[]>(p.tags, []),
      folderId: p.folderId,
      favorite: favSet.has(p.id),
      updatedAt: p.updatedAt.toISOString(),
      versionCount: p._count.versions,
      latest: latest ? { id: latest.id, label: latest.label, status: latest.status } : null,
      released: released ? { label: released.label } : null,
      openVersionId: (open ?? latest)?.id ?? null,
    };
  });
  const folderRows: FolderRow[] = folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, count: all.filter((p) => p.folderId === f.id).length }));

  return (
    <ProjectsView
      projects={rows}
      folders={folderRows}
      tags={tags}
      totals={{ all: all.length, favorites: all.filter((p) => favSet.has(p.id)).length }}
      filters={{ folder: sp.folder ?? null, tag: sp.tag ?? null, state, q, view }}
      canCreate={can(ctx, "project.create")}
      templates={templates.map((t) => {
        const c = parseTemplateContent(t.content);
        return { id: t.id, name: t.name, description: t.description, isDefault: t.isDefault, requiredFields: c.requiredFields, styleTemplateId: c.styleTemplateId ?? null, titleBlockLayoutId: c.titleBlockLayoutId ?? null };
      })}
      defaultScheme={ctx.settings.versionScheme}
    />
  );
}
