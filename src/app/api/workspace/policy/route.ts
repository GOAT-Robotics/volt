import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { loadProject } from "@/lib/session";
import { effectivePolicy } from "@/lib/projects";

export const runtime = "nodejs";

/** Approval policy (optionally with a project's template override: ?projectId=). */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const pid = new URL(req.url).searchParams.get("projectId");
  if (pid) {
    const { project } = await loadProject(ctx, pid);
    return { approval: await effectivePolicy(project, ctx.settings) };
  }
  return { approval: ctx.settings.approval };
});
