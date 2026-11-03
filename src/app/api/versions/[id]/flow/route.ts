import { route } from "@/lib/api";
import { apiCtx, loadProject } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { versionFlow } from "@/lib/workflow";

export const runtime = "nodejs";

/** Where the version is in draft → review → signatures → release and what the viewer can do next. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  const { projectRoles } = await loadProject(ctx, a.project.id);
  return { flow: await versionFlow(ctx, a, projectRoles) };
});
