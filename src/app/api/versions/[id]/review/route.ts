import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { loadProject } from "@/lib/session";
import { reviewInfo } from "@/lib/workflow";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  const { projectRoles } = await loadProject(ctx, a.project.id);
  return reviewInfo(ctx, id, projectRoles);
});
