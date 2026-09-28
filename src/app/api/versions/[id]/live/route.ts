import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { join, submitOps, updatePresence } from "@/lib/live/hub";
import type { LiveOp } from "@/core/live-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Join the live session of a version: a Server-Sent Events stream (document, changes, presence). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiCtx();
    const { id } = await params;
    if (!ctx.settings.collaboration.live) throw new HttpError(403, "Live collaboration is turned off for this workspace", "LIVE_DISABLED");
    const a = await loadVersion(ctx, id, { withDoc: false });
    const mode = new URL(req.url).searchParams.get("mode") === "view" ? "view" : "edit";
    const stream = await join({ versionId: id, projectId: a.project.id, workspaceId: a.project.workspaceId, user: ctx.user, canEdit: a.editable, mode, signal: req.signal });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" },
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[live] join", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status, headers: { "content-type": "application/json" } });
  }
}

const Seg = z.union([z.string().max(200), z.object({ id: z.string().max(200) })]);
const Op = z.discriminatedUnion("t", [
  z.object({ t: z.literal("set"), path: z.array(Seg).min(1).max(40), value: z.unknown() }),
  z.object({ t: z.literal("unset"), path: z.array(Seg).min(1).max(40) }),
  z.object({ t: z.literal("ins"), path: z.array(Seg).min(1).max(40), item: z.object({ id: z.string() }).passthrough(), after: z.string().nullable() }),
  z.object({ t: z.literal("del"), path: z.array(Seg).min(1).max(40), id: z.string() }),
]);
const Presence = z
  .object({
    pageId: z.string().max(200).nullable(),
    cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
    sel: z.object({ elements: z.array(z.string()).max(2000), wires: z.array(z.string()).max(2000), texts: z.array(z.string()).max(2000), junctions: z.array(z.string()).max(2000), shapes: z.array(z.string()).max(2000) }).nullable(),
    view: z.object({ cx: z.number(), cy: z.number(), s: z.number() }).nullable(),
    drag: z.object({ sel: z.any(), dx: z.number(), dy: z.number() }).nullable(),
    mode: z.enum(["edit", "view"]),
  })
  .partial();
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ops"), clientId: z.string(), batchId: z.string().max(64), ops: z.array(Op).max(20000) }),
  z.object({ kind: z.literal("presence"), clientId: z.string(), presence: Presence }),
]);

/** Changes and presence from a connected client. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body, 24 * 1024 * 1024);
  if (!ctx.settings.collaboration.live) throw new HttpError(409, "Live collaboration is turned off for this workspace", "LIVE_DISABLED");
  try {
    if (b.kind === "ops") return submitOps(id, b.clientId, ctx.user.id, b.batchId, b.ops as LiveOp[]);
    updatePresence(id, b.clientId, ctx.user.id, b.presence);
    return { ok: true };
  } catch (e) {
    const s = (e as { status?: number }).status;
    if (s) throw new HttpError(s, (e as Error).message, s === 409 ? "NOT_CONNECTED" : undefined);
    throw e;
  }
});
