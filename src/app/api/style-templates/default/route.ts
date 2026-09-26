import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { baseStylesFor } from "@/lib/projects";

export const runtime = "nodejs";

/** Default approved style template of the workspace, or the built-in defaults. */
export const GET = route(async () => {
  const ctx = await apiCtx();
  const b = await baseStylesFor(ctx.workspace.id);
  if (!b.ref) return { id: null, name: "Built-in defaults", version: 0, styles: b.styles };
  return { id: b.ref.templateId, name: b.ref.name, version: b.ref.version, styles: b.styles };
});
