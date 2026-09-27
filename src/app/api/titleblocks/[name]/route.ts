import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { standardTitleBlocks } from "@/lib/titleblocks";
import { layoutTemplate, usableLayouts } from "@/lib/titleblock-layouts";

export const runtime = "nodejs";

/** One template: ?source=org for an organization layout (by id or name), else a standard one. */
export const GET = route<{ name: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const name = decodeURIComponent((await params).name);
  if (new URL(req.url).searchParams.get("source") === "org") {
    const l = (await usableLayouts(ctx.workspace.id)).find((x) => x.id === name || x.name === name);
    const t = l && layoutTemplate(l);
    if (!t) throw new HttpError(404, "Title block layout not found");
    return { template: t, layout: { id: l.id, version: l.version } };
  }
  const t = (await standardTitleBlocks()).find((x) => x.name === name);
  if (!t) throw new HttpError(404, "Title block template not found");
  return { template: t };
});
