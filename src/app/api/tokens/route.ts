import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { createToken, tokenDto } from "@/lib/mcp/tokens";

export const runtime = "nodejs";

/** my personal access tokens (MCP) in the current workspace */
export const GET = route(async () => {
  const ctx = await apiCtx();
  const rows = await db.apiToken.findMany({ where: { userId: ctx.user.id, workspaceId: ctx.workspace.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
  return { tokens: rows.map(tokenDto) };
});

const Body = z.object({
  name: z.string().trim().min(1, "Give the token a name").max(80),
  scope: z.enum(["READ", "EDIT"]),
  days: z.number().int().min(1).max(366).nullable(),
});

/** a new token; its secret is in this response only */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`token.create:${ctx.user.id}`, 10);
  if (!ctx.settings.mcp.enabled) throw new HttpError(403, "The MCP server is turned off for this workspace");
  const b = await body(req, Body);
  const active = await db.apiToken.count({ where: { userId: ctx.user.id, revokedAt: null } });
  if (active >= 20) throw new HttpError(409, "You have 20 tokens — revoke one you no longer use first");
  const { token, row } = await createToken(ctx, { name: b.name, scope: b.scope, days: b.days });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "token.create", data: { name: b.name, scope: b.scope, days: b.days, prefix: row.prefix } });
  return { token, ...tokenDto(row) };
});
