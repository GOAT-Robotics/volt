import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { standardTitleBlocks } from "@/lib/titleblocks";
import { usableLayouts } from "@/lib/titleblock-layouts";
import { titleBlockHeight } from "@/core/qet/titleblock";

export const runtime = "nodejs";

/** Title block templates offered in the editor: the organization's approved layouts and the standard set. */
export const GET = route(async () => {
  const ctx = await apiCtx();
  const [t, org] = await Promise.all([standardTitleBlocks(), usableLayouts(ctx.workspace.id)]);
  return {
    organization: org.map((l) => ({ id: l.id, name: l.name, version: l.version, isDefault: l.isDefault })),
    templates: t.map((x) => ({ name: x.name, height: titleBlockHeight(x), fields: x.cells.filter((c) => c.type === "field").length })),
  };
});
