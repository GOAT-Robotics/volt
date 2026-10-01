import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCtx, requireCtx, HttpError } from "@/lib/session";
import { projectPreview } from "@/lib/og/preview";
import { previewMetadata } from "@/lib/og/meta";
import { loadVersion } from "@/lib/versioning";
import { preload } from "react-dom";
import { EditorClient } from "@/editor/ui/EditorClient";

export async function generateMetadata({ params }: { params: Promise<{ projectId: string; versionId: string }> }): Promise<Metadata> {
  const { projectId, versionId } = await params;
  const ctx = await getCtx();
  const a = ctx ? await loadVersion(ctx, versionId, { withDoc: false }).catch(() => null) : null;
  if (!a || a.project.id !== projectId) return { title: "Editor" };
  const pv = await projectPreview(projectId).catch(() => null);
  const title = `${a.project.name} · ${a.version.label}`;
  return pv ? previewMetadata(pv, { title }) : { title };
}

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
        live: ctx.settings.collaboration.live,
        brand: { name: ctx.settings.branding.name, address: ctx.settings.branding.address, logo: ctx.settings.branding.logo },
      }}
    />
  );
}
