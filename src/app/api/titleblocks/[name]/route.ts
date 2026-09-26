import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { standardTitleBlocks } from "@/lib/titleblocks";

export const runtime = "nodejs";

export const GET = route<{ name: string }>(async (_req, { params }) => {
  await apiCtx();
  const { name } = await params;
  const t = (await standardTitleBlocks()).find((x) => x.name === decodeURIComponent(name));
  if (!t) throw new HttpError(404, "Title block template not found");
  return { template: t };
});
