import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { tokenDto } from "@/lib/mcp/tokens";
import { TOOLS } from "@/lib/mcp/tools";
import { ConnectView } from "./ConnectView";

export const metadata: Metadata = { title: "Connect AI" };

export default async function ConnectPage() {
  const ctx = await requireCtx();
  const rows = await db.apiToken.findMany({ where: { userId: ctx.user.id, workspaceId: ctx.workspace.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
  const h = await headers();
  const env = (process.env.APP_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "");
  const origin = env || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  return (
    <ConnectView
      url={`${origin}/api/mcp`}
      enabled={ctx.settings.mcp.enabled}
      allowEdits={ctx.settings.mcp.allowEdits}
      workspace={ctx.workspace.name}
      tokens={rows.map(tokenDto)}
      tools={TOOLS.map((t) => ({ name: t.name, title: t.title, access: t.access }))}
    />
  );
}
