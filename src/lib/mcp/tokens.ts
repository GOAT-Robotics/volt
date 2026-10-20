/**
 * Personal access tokens for the MCP server. A token belongs to one person and one workspace; an
 * assistant using it works as that person, with their roles and projects. Only the SHA-256 of a
 * token is stored; the token itself is shown once, when it is created.
 */
import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../db";
import { ctxForUser, HttpError, type Ctx } from "../session";

export const TOKEN_PREFIX = "volt_pat_";
export type TokenScope = "READ" | "EDIT";
export type TokenInfo = { id: string; name: string; scope: TokenScope; userId: string };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createToken(ctx: Ctx, input: { name: string; scope: TokenScope; days: number | null }) {
  const secret = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const row = await db.apiToken.create({
    data: {
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      name: input.name,
      prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
      tokenHash: hash(secret),
      scope: input.scope,
      expiresAt: input.days ? new Date(Date.now() + input.days * 86400_000) : null,
    },
  });
  return { token: secret, row };
}

export function tokenDto(t: { id: string; name: string; prefix: string; scope: string; expiresAt: Date | null; lastUsedAt: Date | null; createdAt: Date; revokedAt: Date | null }) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope as TokenScope,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    expired: !!t.expiresAt && t.expiresAt.getTime() < Date.now(),
  };
}

/**
 * The person behind an `Authorization: Bearer volt_pat_…` header. Throws 401 for a missing,
 * unknown, revoked or expired token, and 403 when the workspace has the MCP server switched off.
 */
export async function ctxFromBearer(req: Request): Promise<{ ctx: Ctx; token: TokenInfo }> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "Missing access token: send Authorization: Bearer <token> (create one in Volt under Connect AI)");
  const t = await db.apiToken.findUnique({ where: { tokenHash: hash(m[1]) } });
  if (!t || t.revokedAt) throw new HttpError(401, "Unknown or revoked access token");
  if (t.expiresAt && t.expiresAt.getTime() < Date.now()) throw new HttpError(401, "This access token has expired — create a new one in Volt under Connect AI");
  const ctx = await ctxForUser(t.userId, { workspaceId: t.workspaceId, authTime: 0, strict: true });
  if (!ctx) throw new HttpError(401, "The account of this token has no access to its workspace any more");
  if (!ctx.settings.mcp.enabled) throw new HttpError(403, "The MCP server is turned off for this workspace (Administration → General)");
  // last use, at most once a minute
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) await db.apiToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { ctx, token: { id: t.id, name: t.name, scope: t.scope === "READ" ? "READ" : "EDIT", userId: t.userId } };
}
