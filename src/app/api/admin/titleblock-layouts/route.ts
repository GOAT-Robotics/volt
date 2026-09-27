import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { parseHistory, pushHistory } from "@/lib/styletemplates";
import { standardTitleBlocks } from "@/lib/titleblocks";
import { defaultTitleBlock } from "@/core/doc";
import { serializeTitleBlockTemplate } from "@/core/qet/titleblock";
import { checkLayoutXml, MAX_LAYOUT_XML } from "@/lib/titleblock-layouts";

export const runtime = "nodejs";
export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await db.titleBlockLayout.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return { layouts: rows.map((t) => ({ id: t.id, name: t.name, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), history: parseHistory(t.history).map(({ content: _c, styles: _s, ...h }) => h) })) };
});

const Create = z.object({
  name: z.string().trim().min(1).max(120),
  /** copy an organization layout */
  fromId: z.string().nullish(),
  /** start from a standard (QElectroTech) template */
  standard: z.string().max(200).nullish(),
  /** a .titleblock file or a template from a drawing */
  xml: z.string().max(MAX_LAYOUT_XML).nullish(),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, Create, MAX_LAYOUT_XML + 64 * 1024);
  if (await db.titleBlockLayout.findFirst({ where: { workspaceId: ctx.workspace.id, name: b.name } })) throw new HttpError(409, `A layout called “${b.name}” already exists`);
  let xml: string;
  if (b.xml) xml = b.xml;
  else if (b.fromId) {
    const src = await db.titleBlockLayout.findFirst({ where: { id: b.fromId, workspaceId: ctx.workspace.id } });
    if (!src) throw new HttpError(404, "Source layout not found");
    xml = src.xml;
  } else if (b.standard) {
    const std = (await standardTitleBlocks()).find((t) => t.name === b.standard);
    if (!std?.xml) throw new HttpError(404, "Standard template not found");
    xml = std.xml;
  } else xml = serializeTitleBlockTemplate({ ...defaultTitleBlock(), name: b.name, xml: undefined });
  xml = checkLayoutXml(xml, b.name);
  const t = await db.titleBlockLayout.create({
    data: {
      workspaceId: ctx.workspace.id,
      name: b.name,
      xml,
      ownerId: ctx.user.id,
      history: pushHistory("[]", { version: 1, action: b.fromId ? "copy" : "create", at: new Date().toISOString(), by: ctx.user.name, name: b.name, note: b.standard ? `From standard “${b.standard}”` : b.xml ? "Imported" : undefined }),
    },
  });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: "create", titleBlockLayout: b.name, id: t.id } });
  return { id: t.id };
});
