import "server-only";
import { db } from "./db";
import { approvedStyles } from "./styletemplates";
import { defaultStyles } from "@/core/styles";
import type { Doc, Styles } from "@/core/model";
import { docHash, nextLabel, reindexVersion } from "./versioning";
import { parseTemplateContent, type ProjectTemplateContent } from "./templates";
import { DEFAULT_SETTINGS, type ApprovalPolicy, type WorkspaceSettings } from "./settings";

/** Base styles for new documents: explicit template, else the workspace default approved template, else built-in. */
export async function baseStylesFor(workspaceId: string, styleTemplateId?: string | null): Promise<{ styles: Styles; ref?: Doc["baseStylesRef"] }> {
  const t =
    (styleTemplateId ? await db.styleTemplate.findFirst({ where: { id: styleTemplateId, workspaceId, status: { not: "RETIRED" } } }) : null) ??
    (await db.styleTemplate.findFirst({ where: { workspaceId, isDefault: true, status: { not: "RETIRED" } } }));
  const ok = t ? approvedStyles(t) : null;
  if (!t || !ok) return { styles: defaultStyles() };
  return { styles: ok.styles, ref: { templateId: t.id, version: ok.version, name: t.name } };
}

export async function templateFor(workspaceId: string, templateId: string | null | undefined): Promise<ProjectTemplateContent | null> {
  if (!templateId) return null;
  const t = await db.projectTemplate.findFirst({ where: { id: templateId, workspaceId } });
  return t ? parseTemplateContent(t.content) : null;
}

/** Workspace approval policy with the project template override applied. */
export async function effectivePolicy(project: { workspaceId: string; templateId: string | null }, settings?: WorkspaceSettings): Promise<ApprovalPolicy> {
  const base = settings?.approval ?? DEFAULT_SETTINGS.approval;
  const t = await templateFor(project.workspaceId, project.templateId);
  return { ...base, ...(t?.approval ?? {}) };
}

export async function requiredFieldsFor(project: { workspaceId: string; templateId: string | null }): Promise<string[]> {
  const t = await templateFor(project.workspaceId, project.templateId);
  return t?.requiredFields ?? [];
}

/** Create project + version 1 (DRAFT) in one transaction and index it. */
export async function createProjectRecord(input: {
  workspaceId: string;
  userId: string;
  name: string;
  number?: string | null;
  description?: string;
  folderId?: string | null;
  tags?: string[];
  versionScheme?: string;
  customScheme?: string | null;
  templateId?: string | null;
  doc: Doc;
  summary: string;
}) {
  const scheme = input.versionScheme ?? "INTEGER";
  const label = nextLabel(scheme, null, 1, input.customScheme);
  const { project, version } = await db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        number: input.number || null,
        description: input.description ?? "",
        folderId: input.folderId || null,
        tags: JSON.stringify(input.tags ?? []),
        versionScheme: scheme,
        customScheme: input.customScheme ?? null,
        templateId: input.templateId ?? null,
        createdById: input.userId,
        members: { create: { userId: input.userId, roles: "" } },
      },
    });
    const version = await tx.version.create({
      data: { projectId: project.id, seq: 1, label, status: "DRAFT", summary: input.summary, doc: JSON.stringify(input.doc), docHash: docHash(input.doc), createdById: input.userId },
    });
    return { project, version };
  });
  await reindexVersion(version.id, project.id, input.doc);
  return { project, version };
}

export const WORKING = ["DRAFT", "CHANGES_REQUESTED"];
export const IMMUTABLE = ["IN_REVIEW", "APPROVED", "SIGNED", "RELEASED", "SUPERSEDED", "WITHDRAWN", "REJECTED", "OBSOLETE"];
