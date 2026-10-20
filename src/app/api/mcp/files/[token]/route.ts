import { route } from "@/lib/api";
import { audit } from "@/lib/audit";
import { fileResponse } from "@/lib/access";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { ctxForLink, makeFile } from "@/lib/mcp/files";

export const runtime = "nodejs";

/**
 * A file an assistant asked for through the MCP server (export_file): the link is signed, names
 * the access token and expires after an hour. No cookie is needed, so it opens in any browser.
 */
export const GET = route<{ token: string }>(async (req, { params }) => {
  const { token } = await params;
  const { ctx, claim, tokenName } = await ctxForLink(token);
  rateLimit(`mcp.file:${claim.t}`, 30);
  const f = await makeFile(ctx, claim.v, claim.f, { pages: claim.p, paper: claim.paper });
  const v = await db.version.findUnique({ where: { id: claim.v }, select: { projectId: true, project: { select: { workspaceId: true } } } });
  if (v) await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: claim.v, actorId: ctx.user.id, type: "project.export", data: { format: claim.f, label: f.label, size: f.bytes.byteLength, via: `mcp: ${tokenName}` } });
  return fileResponse(f.bytes, { filename: f.filename, type: f.type, inline: new URL(req.url).searchParams.has("inline") });
});
