/**
 * Live collaboration hub (server, in memory, one process).
 *
 * One room per version that someone has open. The room holds the authoritative document, orders
 * every change (seq), fans changes and presence out to everyone in the room over Server-Sent
 * Events, and saves the document to the database a moment after the last change. Clients apply
 * their own changes at once and reconcile with the server order (see src/editor/live/client.ts).
 */
import "server-only";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { docHash, scheduleReindex, withStoredSource } from "@/lib/versioning";
import { applyOps, type LiveOp } from "@/core/live-ops";
import { randomBytes } from "node:crypto";
import type { Doc, Pt } from "@/core/model";
import { liveHooks } from "./hooks";

export type Mode = "edit" | "view";
export type Presence = {
  pageId?: string | null;
  cursor?: Pt | null;
  sel?: { elements: string[]; wires: string[]; texts: string[]; junctions: string[]; shapes: string[] } | null;
  /** world-space centre and zoom of the visible area (followers copy it) */
  view?: { cx: number; cy: number; s: number } | null;
  /** components being dragged right now (others see them move) */
  drag?: { sel: Presence["sel"]; dx: number; dy: number } | null;
  mode?: Mode;
};
export type Peer = Presence & { clientId: string; userId: string; name: string; email: string; color: string; canEdit: boolean; since: number };

type Client = Peer & { send: (msg: string) => void; close: () => void };
type Room = {
  versionId: string;
  projectId: string;
  workspaceId: string;
  doc: Doc;
  rev: number;
  seq: number;
  editable: boolean;
  clients: Map<string, Client>;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  firstDirtyAt: number;
  saving: Promise<void> | null;
  lastEditor: string | null;
  lastAudit: Map<string, number>;
  /** being closed (live collaboration switched off): no more changes accepted */
  closing?: boolean;
};

const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#b45309"];
const SAVE_DEBOUNCE = 1200;
const SAVE_MAX_WAIT = 5000;

const g = globalThis as unknown as { __voltLive?: Map<string, Room>; __voltLiveExit?: boolean };
const rooms: Map<string, Room> = (g.__voltLive ??= new Map());
// on shutdown (deploy, restart) write every room's unsaved changes first — best effort; clients
// also resend changes the server confirmed but had not saved when it went away
if (!g.__voltLiveExit) {
  g.__voltLiveExit = true;
  const save = () => Promise.all([...rooms.values()].map((r) => flush(r).catch(() => {})));
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void save().finally(() => process.kill(process.pid, sig)));
}

liveHooks.flush = (id) => flushVersion(id);
liveHooks.readonly = (id, reason) => notifyVersion(id, { type: "readonly", reason });
liveHooks.disable = (workspaceId) => closeWorkspace(workspaceId);

const sse = (msg: unknown) => `data: ${JSON.stringify(msg)}\n\n`;
const publicPeer = (c: Client): Peer => {
  const { send: _s, close: _c, ...p } = c;
  return p;
};

function broadcast(room: Room, msg: unknown, except?: string) {
  const s = sse(msg);
  for (const c of room.clients.values()) if (c.clientId !== except) c.send(s);
}

async function loadRoom(versionId: string, projectId: string, workspaceId: string, editable: boolean): Promise<Room> {
  const cur = rooms.get(versionId);
  if (cur) return cur;
  // the document without the original project file (it stays in the database), like GET /doc
  const rows = await db.$queryRaw<{ d: string; rev: number }[]>`
    SELECT CASE WHEN json_type(doc, '$.qet.source') IS NOT NULL
      THEN json_set(json_remove(doc, '$.qet.source'), '$.qet.hasSource', json('true'))
      ELSE doc END AS d, docRev AS rev
    FROM "Version" WHERE id = ${versionId}`;
  if (!rows[0]) throw new Error("Version not found");
  const again = rooms.get(versionId);
  if (again) return again;
  const room: Room = { versionId, projectId, workspaceId, doc: JSON.parse(rows[0].d) as Doc, rev: Number(rows[0].rev), seq: 0, editable, clients: new Map(), dirty: false, timer: null, firstDirtyAt: 0, saving: null, lastEditor: null, lastAudit: new Map() };
  rooms.set(versionId, room);
  return room;
}

function pickColor(room: Room, userId: string): string {
  // the same person keeps the same colour; otherwise the least used one
  for (const c of room.clients.values()) if (c.userId === userId) return c.color;
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const c of room.clients.values()) used.set(c.color, (used.get(c.color) ?? 0) + 1);
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const min = Math.min(...used.values());
  const free = COLORS.filter((c) => used.get(c) === min);
  return free[h % free.length];
}

/** Open a live connection; returns the SSE stream for the response. */
export async function join(a: { versionId: string; projectId: string; workspaceId: string; user: { id: string; name: string; email: string }; canEdit: boolean; mode: Mode; signal: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
  const room = await loadRoom(a.versionId, a.projectId, a.workspaceId, a.canEdit);
  if (a.canEdit) room.editable = true;
  const enc = new TextEncoder();
  const clientId = randomBytes(16).toString("hex");
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const leave = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    room.clients.delete(clientId);
    broadcast(room, { type: "leave", clientId });
    if (!room.clients.size) {
      // last one out: save, then forget the room
      void flush(room).finally(() => {
        if (!room.clients.size && !room.dirty && rooms.get(room.versionId) === room) rooms.delete(room.versionId);
      });
    }
  };
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      const client: Client = {
        clientId,
        userId: a.user.id,
        name: a.user.name || a.user.email,
        email: a.user.email,
        color: pickColor(room, a.user.id),
        canEdit: a.canEdit,
        mode: a.canEdit ? a.mode : "view",
        since: Date.now(),
        send: (s) => {
          if (closed) return;
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            leave();
          }
        },
        close: () => {
          try {
            ctrl.close();
          } catch {}
          leave();
        },
      };
      room.clients.set(clientId, client);
      client.send(sse({ type: "hello", clientId, color: client.color, seq: room.seq, rev: room.rev, editable: room.editable && a.canEdit, doc: room.doc, peers: [...room.clients.values()].filter((c) => c.clientId !== clientId).map(publicPeer) }));
      broadcast(room, { type: "join", peer: publicPeer(client) }, clientId);
      ping = setInterval(() => client.send(": ping\n\n"), 20_000);
      a.signal.addEventListener("abort", leave);
    },
    cancel: leave,
  });
}

function clientOf(versionId: string, clientId: string, userId: string): { room: Room; client: Client } {
  const room = rooms.get(versionId);
  const client = room?.clients.get(clientId);
  if (!room || !client || client.userId !== userId) throw Object.assign(new Error("Not connected — reconnecting"), { status: 409 });
  return { room, client };
}

/** A batch of changes from one client: applied in arrival order and sent to everyone. */
export function submitOps(versionId: string, clientId: string, userId: string, batchId: string, ops: LiveOp[]): { seq: number } {
  const { room, client } = clientOf(versionId, clientId, userId);
  if (room.closing) throw Object.assign(new Error("Live collaboration was turned off"), { status: 409 });
  if (!client.canEdit || client.mode !== "edit" || !room.editable) throw Object.assign(new Error("This version is read-only for you"), { status: 403 });
  applyOps(room.doc, ops);
  room.seq++;
  room.lastEditor = userId;
  broadcast(room, { type: "ops", seq: room.seq, clientId, batchId, ops, by: client.name, color: client.color });
  markDirty(room);
  return { seq: room.seq };
}

/** Cursor, selection, sheet, viewport, drag and mode of one client (only the fields that changed). */
export function updatePresence(versionId: string, clientId: string, userId: string, p: Presence) {
  const { room, client } = clientOf(versionId, clientId, userId);
  if (p.mode) client.mode = client.canEdit ? p.mode : "view";
  for (const k of ["pageId", "cursor", "sel", "view", "drag"] as const) if (k in p) (client as Presence)[k] = p[k] as never;
  broadcast(room, { type: "presence", peer: publicPeer(client) }, clientId);
}

function markDirty(room: Room) {
  if (!room.dirty) room.firstDirtyAt = Date.now();
  room.dirty = true;
  if (room.timer) clearTimeout(room.timer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE, room.firstDirtyAt + SAVE_MAX_WAIT - Date.now()));
  room.timer = setTimeout(() => void flush(room), wait);
}

/** Save the room's document (optimistic on docRev, like PUT /doc). */
async function flush(room: Room): Promise<void> {
  if (room.saving) {
    await room.saving;
    if (room.dirty) return flush(room);
    return;
  }
  if (!room.dirty) return;
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.saving = (async () => {
    room.dirty = false;
    const snapshot = JSON.parse(JSON.stringify(room.doc)) as Doc;
    try {
      let stored: string | null = null;
      if (snapshot.qet?.hasSource) {
        const r = await db.$queryRaw<{ s: string | null }[]>`SELECT json_extract(doc, '$.qet.source') AS s FROM "Version" WHERE id = ${room.versionId}`;
        stored = r[0]?.s ?? null;
      }
      const doc = withStoredSource(snapshot, stored);
      const res = await db.version.updateMany({
        where: { id: room.versionId, docRev: room.rev, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } },
        data: { doc: JSON.stringify(doc), docRev: { increment: 1 }, docHash: docHash(doc) },
      });
      if (res.count === 0) return await resync(room);
      room.rev++;
      broadcast(room, { type: "saved", rev: room.rev, seq: room.seq });
      const actor = room.lastEditor;
      const last = actor ? room.lastAudit.get(actor) ?? 0 : Date.now();
      if (actor && Date.now() - last > 10 * 60_000) {
        room.lastAudit.set(actor, Date.now());
        await audit({ workspaceId: room.workspaceId, projectId: room.projectId, versionId: room.versionId, actorId: actor, type: "version.save", data: { rev: room.rev, live: true } }).catch(() => {});
      }
      await db.project.update({ where: { id: room.projectId }, data: { updatedAt: new Date() } }).catch(() => {});
      scheduleReindex(room.versionId, room.projectId, doc);
    } catch (e) {
      console.error("[live] save failed", room.versionId, e);
      room.dirty = true;
      broadcast(room, { type: "error", message: "Saving failed — retrying" });
      room.timer = setTimeout(() => void flush(room), 5000);
    }
  })();
  try {
    await room.saving;
  } finally {
    room.saving = null;
  }
}

/** The stored version moved on without us (frozen, or saved outside the room): follow it. */
async function resync(room: Room) {
  const v = await db.version.findUnique({ where: { id: room.versionId }, select: { status: true, docRev: true } });
  if (!v) return;
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(v.status)) {
    room.editable = false;
    broadcast(room, { type: "readonly", reason: v.status === "IN_REVIEW" ? "Submitted for review — this version is now frozen" : `This version is ${v.status.toLowerCase().replace("_", " ")}` });
    return;
  }
  const rows = await db.$queryRaw<{ d: string; rev: number }[]>`
    SELECT CASE WHEN json_type(doc, '$.qet.source') IS NOT NULL
      THEN json_set(json_remove(doc, '$.qet.source'), '$.qet.hasSource', json('true'))
      ELSE doc END AS d, docRev AS rev
    FROM "Version" WHERE id = ${room.versionId}`;
  if (!rows[0]) return;
  room.doc = JSON.parse(rows[0].d);
  room.rev = Number(rows[0].rev);
  room.seq++;
  broadcast(room, { type: "snapshot", seq: room.seq, rev: room.rev, doc: room.doc, reason: "The version was saved outside this live session; everyone was brought to the saved state." });
}

/** Save now (before submitting for review, starting a new version, exporting a release …). */
export async function flushVersion(versionId: string) {
  const room = rooms.get(versionId);
  if (room) await flush(room);
}

/** Tell everyone in a room that the version changed state (e.g. submitted for review). */
export function notifyVersion(versionId: string, msg: { type: "readonly"; reason: string }) {
  const room = rooms.get(versionId);
  if (!room) return;
  room.editable = false;
  broadcast(room, msg);
}

/**
 * Live collaboration was switched off: save every room of the workspace, tell its editors to carry
 * on with normal saving from the saved revision, and close the rooms.
 */
export async function closeWorkspace(workspaceId: string) {
  const list = [...rooms.values()].filter((r) => r.workspaceId === workspaceId);
  await Promise.all(
    list.map(async (room) => {
      room.closing = true;
      await flush(room).catch(() => {});
      if (rooms.get(room.versionId) === room) rooms.delete(room.versionId);
      broadcast(room, { type: "disabled", rev: room.rev, seq: room.seq, reason: "An admin turned off live collaboration — you're editing on your own now; changes save as usual." });
      for (const c of [...room.clients.values()]) c.close();
    }),
  );
}

/** Who is in which project right now (one entry per person and version). */
export function livePeople(projectIds: string[]): Record<string, { userId: string; name: string; color: string; versionId: string; pageId: string | null; mode: Mode; since: number }[]> {
  const want = new Set(projectIds);
  const out: Record<string, { userId: string; name: string; color: string; versionId: string; pageId: string | null; mode: Mode; since: number }[]> = {};
  for (const room of rooms.values()) {
    if (!want.has(room.projectId)) continue;
    const list = (out[room.projectId] ??= []);
    for (const c of room.clients.values()) {
      const cur = list.find((x) => x.userId === c.userId && x.versionId === room.versionId);
      if (cur) {
        if (c.mode === "edit") cur.mode = "edit";
        continue;
      }
      list.push({ userId: c.userId, name: c.name, color: c.color, versionId: room.versionId, pageId: c.pageId ?? null, mode: c.mode ?? "view", since: c.since });
    }
  }
  return out;
}
