import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { standardTitleBlocks } from "@/lib/titleblocks";
import { titleBlockHeight } from "@/core/qet/titleblock";

export const runtime = "nodejs";

export const GET = route(async () => {
  await apiCtx();
  const t = await standardTitleBlocks();
  return { templates: t.map((x) => ({ name: x.name, height: titleBlockHeight(x), fields: x.cells.filter((c) => c.type === "field").length })) };
});
