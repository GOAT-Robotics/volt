import { headers } from "next/headers";
import { db } from "./db";

export type AuditInput = {
  workspaceId?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  actorId?: string | null;
  type: string;
  data?: Record<string, unknown>;
};

export async function audit(e: AuditInput) {
  let ip: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  } catch {}
  await db.auditEvent.create({
    data: {
      workspaceId: e.workspaceId ?? null,
      projectId: e.projectId ?? null,
      versionId: e.versionId ?? null,
      actorId: e.actorId ?? null,
      type: e.type,
      data: JSON.stringify(e.data ?? {}),
      ip,
    },
  });
}

export const AUDIT_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "project.create": "Created project",
  "project.import": "Imported project",
  "project.export": "Exported",
  "project.update": "Updated project",
  "project.archive": "Archived project",
  "project.member": "Changed project members",
  "version.create": "Started new version",
  "version.save": "Saved version",
  "version.submit": "Submitted for review",
  "version.status": "Changed version status",
  "version.release": "Released version",
  "version.supersede": "Superseded version",
  "version.withdraw": "Withdrew version",
  "version.recall": "Recalled version",
  "version.commit": "Committed",
  "document.add": "Added document",
  "document.remove": "Removed document",
  "version.obsolete": "Marked version obsolete",
  "variant.create": "Created variant",
  "variant.update": "Changed variant",
  "ai.review": "AI review",
  "review.approve": "Approved",
  "review.reject": "Rejected",
  "review.changes": "Requested changes",
  "comment.create": "Commented",
  "comment.status": "Changed comment status",
  "signature.request": "Requested signature",
  "signature.sign": "Signed",
  "signature.decline": "Declined to sign",
  "signature.invalidate": "Signature invalidated",
  "library.create": "Created library element",
  "library.update": "Updated library element",
  "library.share": "Changed sharing",
  "library.approve": "Approved library element",
  "library.import": "Imported library",
  "style.update": "Changed style template",
  "template.update": "Changed project template",
  "admin.settings": "Changed workspace settings",
  "admin.member": "Changed workspace member",
  "admin.group": "Changed group mapping",
};
