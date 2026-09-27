import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { TEXT_ROLES } from "@/core/model";
import { normalizeStyles, pushHistory } from "@/lib/styletemplates";

export const runtime = "nodejs";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use #rrggbb colors");
const TextStyle = z.object({
  font: z.string().min(1).max(200),
  size: z.number().min(2).max(72),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  color,
  background: color.nullable(),
  align: z.enum(["left", "center", "right"]),
  rotation: z.number().min(-360).max(360),
  dx: z.number().min(-500).max(500),
  dy: z.number().min(-500).max(500),
  lineHeight: z.number().min(0.5).max(4),
  visible: z.boolean(),
});
const Line = { color, width: z.number().min(0).max(20), dash: z.enum(["solid", "dashed", "dotted", "dashdot"]) };
const Styles = z.object({
  text: z.object(Object.fromEntries(TEXT_ROLES.map((r) => [r, TextStyle])) as Record<(typeof TEXT_ROLES)[number], typeof TextStyle>),
  graphics: z.object({
    wire: z.object({ ...Line, junctionRadius: z.number().min(0).max(20), junctionColor: color, highlight: color }),
    bus: z.object(Line),
    pin: z.object({ color, size: z.number().min(0).max(20), showPoint: z.boolean() }),
    outline: z.object({ color: color.nullable(), widthScale: z.number().min(0.1).max(10) }),
    frame: z.object({ ...Line, show: z.boolean(), padding: z.number().min(0).max(100) }).optional(),
    border: z.object({ ...Line, headerColor: color, font: z.string().min(1).max(200), size: z.number().min(2).max(40) }),
    titleBlock: z.object({ ...Line, font: z.string().min(1).max(200) }),
    selection: color,
    review: z.object({ added: color, removed: color, changed: color, comment: color }),
  }),
});

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  styles: Styles.optional(),
  note: z.string().max(500).optional(),
  action: z.enum(["approve", "setDefault", "retire", "reactivate"]).optional(),
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const b = await body(req, Patch);
  const t = await db.styleTemplate.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!t) throw new HttpError(404, "Style template not found");
  const at = new Date().toISOString();
  if (b.styles || (b.name && b.name !== t.name)) {
    // every edit is a new template version and needs re-approval; the last approved snapshot stays in use meanwhile
    const version = t.version + 1;
    const styles = b.styles ? normalizeStyles(b.styles) : undefined;
    await db.styleTemplate.update({
      where: { id },
      data: {
        ...(b.name && { name: b.name }),
        ...(styles && { styles: JSON.stringify(styles) }),
        version,
        status: "DRAFT",
        history: pushHistory(t.history, { version, action: "edit", at, by: ctx.user.name, note: b.note, name: b.name ?? t.name }),
      },
    });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: "edit", name: b.name ?? t.name, version } });
    return { ok: true, version };
  }
  const cur = await db.styleTemplate.findUniqueOrThrow({ where: { id } });
  switch (b.action) {
    case "approve":
      if (cur.status === "APPROVED") throw new HttpError(409, "Already approved");
      await db.styleTemplate.update({ where: { id }, data: { status: "APPROVED", history: pushHistory(cur.history, { version: cur.version, action: "approve", at, by: ctx.user.name, styles: JSON.parse(cur.styles) }) } });
      break;
    case "setDefault":
      if (cur.status === "RETIRED") throw new HttpError(409, "A retired template cannot be the default");
      if (cur.status !== "APPROVED" && !cur.history.includes('"approve"')) throw new HttpError(409, "Approve the template before making it the default");
      await db.$transaction([
        db.styleTemplate.updateMany({ where: { workspaceId: ctx.workspace.id, isDefault: true }, data: { isDefault: false } }),
        db.styleTemplate.update({ where: { id }, data: { isDefault: true, history: pushHistory(cur.history, { version: cur.version, action: "default", at, by: ctx.user.name }) } }),
      ]);
      break;
    case "retire":
      await db.styleTemplate.update({ where: { id }, data: { status: "RETIRED", isDefault: false, history: pushHistory(cur.history, { version: cur.version, action: "retire", at, by: ctx.user.name }) } });
      break;
    case "reactivate":
      await db.styleTemplate.update({ where: { id }, data: { status: "DRAFT" } });
      break;
    default:
      throw new HttpError(400, "Nothing to change");
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: b.action, name: cur.name, version: cur.version } });
  return { ok: true };
});
