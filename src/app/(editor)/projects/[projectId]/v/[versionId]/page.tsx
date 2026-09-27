import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { preload } from "react-dom";
import { EditorClient } from "@/editor/ui/EditorClient";

export const metadata: Metadata = { title: "Editor" };

export default async function EditorPage({ params }: { params: Promise<{ projectId: string; versionId: string }> }) {
  const { projectId, versionId } = await params;
  const ctx = await requireCtx();
  let a;
  try {
    // the document itself is fetched by the editor (compressed JSON, without the original project file)
    a = await loadVersion(ctx, versionId, { withDoc: false });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  if (a.project.id !== projectId) redirect(`/projects/${a.project.id}/v/${versionId}`);
  // start downloading the drawing while the editor code loads (the editor's fetch picks this up)
  preload(`/api/versions/${versionId}/doc`, { as: "fetch", crossOrigin: "anonymous" });
  return (
    <EditorClient
      version={{
        projectId: a.project.id,
        projectName: a.project.name,
        versionId: a.version.id,
        label: a.version.label,
        status: a.version.status,
        docRev: a.version.docRev,
        editable: a.editable,
        reason: a.reason,
        canComment: a.canComment,
        canExport: a.canExport,
        userId: ctx.user.id,
        userName: ctx.user.name,
      }}
    />
  );
}
