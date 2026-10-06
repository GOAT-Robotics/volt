import type { Metadata } from "next";
import { requireCtx } from "@/lib/session";
import { db, J } from "@/lib/db";
import { isAdmin } from "@/lib/access";
import { parseRoles } from "@/lib/roles";
import { parseTemplateContent } from "@/lib/templates";
import { normalizeStyles, parseHistory } from "@/lib/styletemplates";
import { Forbidden } from "@/components/volt/common";
import { standardTitleBlocks } from "@/lib/titleblocks";
import { aiEnabled, aiModel } from "@/lib/ai/openai";
import { AdminView, type AdminData } from "./AdminView";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireCtx();
  if (!isAdmin(ctx)) return <Forbidden title="Administrators only">Workspace administration is limited to users with the Admin role.</Forbidden>;
  const { tab } = await searchParams;
  const wsId = ctx.workspace.id;
  const [members, groups, styles, templates, versions, autosaves, inactive, layouts, standard] = await Promise.all([
    db.membership.findMany({ where: { workspaceId: wsId }, include: { user: true } }),
    db.groupMapping.findMany({ where: { workspaceId: wsId }, orderBy: { displayName: "asc" } }),
    db.styleTemplate.findMany({ where: { workspaceId: wsId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    db.projectTemplate.findMany({ where: { workspaceId: wsId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    db.version.findMany({ where: { project: { workspaceId: wsId } }, select: { id: true, label: true, status: true, project: { select: { name: true } } }, orderBy: [{ project: { name: "asc" } }, { seq: "desc" }], take: 500 }),
    db.autosave.count({ where: { version: { project: { workspaceId: wsId } }, createdAt: { lt: new Date(Date.now() - ctx.settings.retention.deleteAutosavesAfterDays * 86400_000) } } }),
    ctx.settings.retention.archiveAfterDays ? db.project.count({ where: { workspaceId: wsId, state: "ACTIVE", updatedAt: { lt: new Date(Date.now() - ctx.settings.retention.archiveAfterDays * 86400_000) } } }) : Promise.resolve(0),
    db.titleBlockLayout.findMany({ where: { workspaceId: wsId }, omit: { xml: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    standardTitleBlocks(),
  ]);
  const data: AdminData = {
    meId: ctx.user.id,
    workspaceName: ctx.workspace.name,
    settings: ctx.settings,
    members: members
      .map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, roles: parseRoles(m.roles), source: m.source, disabled: m.user.disabled, isGuest: m.user.isGuest, lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    groups: groups.map((g) => ({ id: g.id, entraGroupId: g.entraGroupId, displayName: g.displayName, roles: parseRoles(g.roles) })),
    styleTemplates: styles.map((t) => ({ id: t.id, name: t.name, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), styles: normalizeStyles(J.parse(t.styles, {})), history: parseHistory(t.history).map(({ styles: _s, content: _c, ...h }) => h) })),
    projectTemplates: templates.map((t) => {
      const c = parseTemplateContent(t.content);
      return { id: t.id, name: t.name, description: t.description, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), content: { ...c, doc: null }, seedPages: c.doc?.pages.length ?? 0, history: parseHistory(t.history).map(({ styles: _s, content: _c, ...h }) => h) };
    }),
    titleBlockLayouts: layouts.map((t) => ({ id: t.id, name: t.name, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), history: parseHistory(t.history).map(({ styles: _s, content: _c, ...h }) => h) })),
    standardTitleBlocks: standard.map((t) => t.name),
    versions: versions.map((v) => ({ id: v.id, label: `${v.project.name} — v${v.label} (${v.status.toLowerCase().replace("_", " ")})` })),
    retention: { autosavesDue: autosaves, projectsDue: inactive },
    entraEnabled: !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
    aiModel: aiEnabled() ? aiModel() : null,
  };
  return <AdminView data={data} initialTab={tab ?? "general"} />;
}
