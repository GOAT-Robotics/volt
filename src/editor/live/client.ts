/**
 * Live collaboration client (one per open editor).
 *
 * - Receives the room over Server-Sent Events: the current document, everyone's changes in server
 *   order, presence (cursor, selection, sheet, view, drags), saves and state changes.
 * - Sends local changes as id-addressed operations, one request at a time, in order.
 * - Local changes show immediately. A remote change is applied and then my changes the server has
 *   not confirmed yet are replayed on top: the server applies mine after theirs, so every copy
 *   ends up exactly like the server's.
 * - Reconnects on its own; unacknowledged changes are re-applied on the fresh document and resent.
 */
import { produce } from "immer";
import { applyOps, opKey, type LiveOp } from "@/core/live-ops";
import type { Doc } from "@/core/model";
import type { Sel } from "@/core/ops";
import { setLiveSink, useEditor } from "../store";
import type { Engine } from "../engine/Engine";
import type { Peer, PeerSel } from "./types";

type Batch = { batchId: string; ops: LiveOp[]; keys: string[] };
type Msg =
  | { type: "hello"; clientId: string; color: string; seq: number; rev: number; editable: boolean; doc: Doc; peers: Peer[] }
  | { type: "ops"; seq: number; clientId: string; batchId: string; ops: LiveOp[]; by: string; color: string }
  | { type: "join"; peer: Peer }
  | { type: "presence"; peer: Peer }
  | { type: "leave"; clientId: string }
  | { type: "saved"; rev: number; seq: number }
  | { type: "snapshot"; seq: number; rev: number; doc: Doc; reason: string }
  | { type: "readonly"; reason: string }
  | { type: "error"; message: string };

const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const selOf = (s: Sel): PeerSel => ({ elements: s.elements, wires: s.wires, texts: s.texts, junctions: s.junctions, shapes: s.shapes ?? [] });

export class LiveClient {
  private es: EventSource | null = null;
  private clientId: string | null = null;
  private outbox: Batch[] = [];
  private posting: Batch | null = null;
  private unacked: Batch[] = [];
  private stopped = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresence = "";
  private pendingPresence: Record<string, unknown> = {};
  private viewUnsub: (() => void) | null = null;

  constructor(
    private versionId: string,
    private engine: () => Engine | null,
    private notify: (msg: string, tone?: "error") => void,
    private fallback?: () => void,
  ) {}
  private everConnected = false;
  /** the document as the server has it (every change in server order); mine on top = what I see */
  private base: Doc | null = null;
  /** my batches the server confirmed but has not written to the database yet (resent if it restarts) */
  private unsaved: (Batch & { seq: number })[] = [];
  private savedRev = -1;

  start() {
    setLiveSink((ops) => this.send(ops));
    this.connect();
    // presence: sheet, cursor, selection, drag, mode
    this.unsub = useEditor.subscribe((s, p) => {
      const out: Record<string, unknown> = {};
      if (s.pageId !== p.pageId) out.pageId = s.pageId;
      if (s.cursor !== p.cursor) out.cursor = s.cursor ? { x: Math.round(s.cursor.x * 10) / 10, y: Math.round(s.cursor.y * 10) / 10 } : null;
      if (s.sel !== p.sel) out.sel = selOf(s.sel);
      if (s.drag !== p.drag) out.drag = s.drag ? { sel: selOf(s.drag.sel), dx: s.drag.dx, dy: s.drag.dy } : null;
      if (s.spectator !== p.spectator) {
        out.mode = s.spectator ? "view" : "edit";
      }
      if (Object.keys(out).length) this.presence(out, !!out.drag || out.drag === null || "mode" in out);
      if (s.following && s.following !== p.following) this.follow(s.peers[s.following]);
    });
    this.hookView();
  }

  stop() {
    this.stopped = true;
    setLiveSink(null);
    this.unsub?.();
    this.viewUnsub?.();
    this.es?.close();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    useEditor.setState({ live: { status: "off", clientId: null, color: null }, peers: {}, following: null });
  }

  /** unsent or unacknowledged local changes */
  get pending() {
    return this.outbox.length + (this.posting ? 1 : 0) + this.unacked.length;
  }

  private hookView() {
    const e = this.engine();
    if (!e) {
      setTimeout(() => !this.stopped && this.hookView(), 300);
      return;
    }
    const fn = () => {
      const r = e.worldViewport();
      this.presence({ view: { cx: Math.round(r.x + r.w / 2), cy: Math.round(r.y + r.h / 2), s: Math.round(e.view.s * 1000) / 1000 } });
    };
    e.viewListeners.add(fn);
    this.viewUnsub = () => e.viewListeners.delete(fn);
    fn();
  }

  private connect() {
    if (this.stopped) return;
    const st = useEditor.getState();
    useEditor.setState({ live: { ...st.live, status: st.live.clientId ? "offline" : "connecting" } });
    const es = new EventSource(`/api/versions/${this.versionId}/live?mode=${st.spectator ? "view" : "edit"}`);
    this.es = es;
    es.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data) as Msg);
      } catch (e) {
        console.error("[live] bad message", e);
      }
    };
    es.onerror = () => {
      // take over reconnecting: back off, and start from a fresh hello
      es.close();
      if (this.es !== es || this.stopped) return;
      this.clientId = null;
      this.base = null;
      useEditor.setState((s) => ({ live: { ...s.live, status: "offline", clientId: null }, peers: {} }));
      if (!this.everConnected && this.retry >= 3) return this.fallback?.();
      const wait = Math.min(15000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), wait);
    };
  }

  private onMessage(m: Msg) {
    const st = useEditor.getState();
    switch (m.type) {
      case "hello": {
        this.retry = 0;
        const lost = this.everConnected && m.seq === 0 && m.rev === this.savedRev ? this.unsaved : [];
        if (lost.length) this.notify(`The server restarted — ${lost.length === 1 ? "your last change was" : "your last changes were"} sent again`);
        this.unsaved = [];
        this.savedRev = m.rev;
        this.everConnected = true;
        this.clientId = m.clientId;
        // my changes the server has not seen (or lost in a restart) go on top of its document, then out again
        const mine = [...lost.map(({ seq: _s, ...b }) => b), ...this.unacked, ...(this.posting ? [this.posting] : []), ...this.outbox];
        this.unacked = [];
        this.posting = null;
        this.outbox = mine;
        this.base = m.doc;
        const doc = mine.length ? produce(m.doc, (d: Doc) => mine.forEach((b) => applyOps(d, b.ops))) : m.doc;
        st.replaceDoc(doc, m.rev);
        const peers: Record<string, Peer> = {};
        for (const p of m.peers) peers[p.clientId] = p;
        const version = st.version && !m.editable && st.version.editable ? { ...st.version, editable: false, reason: st.version.reason ?? "You have view access only" } : st.version;
        useEditor.setState({ live: { status: "live", clientId: m.clientId, color: m.color, error: null }, peers, version, ...(mine.length ? {} : { save: st.save === "dirty" ? "dirty" : "saved" }) });
        this.lastPresence = "";
        this.presence({ pageId: st.pageId, sel: selOf(st.sel), mode: st.spectator ? "view" : "edit" }, true);
        const e = this.engine();
        if (e) {
          const r = e.worldViewport();
          this.presence({ view: { cx: Math.round(r.x + r.w / 2), cy: Math.round(r.y + r.h / 2), s: e.view.s } });
        }
        this.flush();
        return;
      }
      case "ops": {
        if (this.base) this.base = produce(this.base, (d: Doc) => applyOps(d, m.ops));
        if (m.clientId === this.clientId) {
          // acknowledgement of my own batch: it is part of the server state now
          const b = [...this.unacked, ...(this.posting ? [this.posting] : []), ...this.outbox].find((x) => x.batchId === m.batchId);
          if (b) this.unsaved.push({ ...b, seq: m.seq });
          this.unacked = this.unacked.filter((b) => b.batchId !== m.batchId);
          if (this.posting?.batchId === m.batchId) this.posting = null;
          this.outbox = this.outbox.filter((b) => b.batchId !== m.batchId);
          return;
        }
        // rebase: server state (with their change) + my unconfirmed changes on top; the server
        // will apply mine after theirs, so this is exactly what it will have
        const mine = [...this.unacked, ...(this.posting ? [this.posting] : []), ...this.outbox].flatMap((b) => b.ops);
        if (this.base) st.setLiveDoc(mine.length ? produce(this.base, (d: Doc) => applyOps(d, mine)) : this.base);
        else st.applyRemote([...m.ops, ...mine]);
        return;
      }
      case "join":
      case "presence": {
        useEditor.setState((s) => ({ peers: { ...s.peers, [m.peer.clientId]: m.peer } }));
        if (st.following === m.peer.clientId) this.follow(m.peer);
        return;
      }
      case "leave": {
        const { [m.clientId]: gone, ...rest } = st.peers;
        useEditor.setState({ peers: rest, ...(st.following === m.clientId ? { following: null } : {}) });
        if (gone && st.following === m.clientId) this.notify(`${gone.name} left — stopped following`);
        return;
      }
      case "saved": {
        this.savedRev = m.rev;
        this.unsaved = this.unsaved.filter((b) => b.seq > m.seq);
        const v = st.version;
        useEditor.setState({ version: v ? { ...v, docRev: m.rev } : v });
        if (!this.pending) st.markSaved(m.rev);
        return;
      }
      case "snapshot": {
        this.base = m.doc;
        this.unsaved = [];
        this.savedRev = m.rev;
        const mine = [...this.unacked, ...(this.posting ? [this.posting] : []), ...this.outbox];
        const doc = mine.length ? produce(m.doc, (d: Doc) => mine.forEach((b) => applyOps(d, b.ops))) : m.doc;
        st.replaceDoc(doc, m.rev);
        this.notify(m.reason);
        return;
      }
      case "readonly": {
        const v = st.version;
        useEditor.setState({ version: v ? { ...v, editable: false, reason: m.reason } : v, save: "readonly" });
        this.outbox = [];
        this.notify(m.reason);
        return;
      }
      case "error":
        this.notify(m.message, "error");
        return;
    }
  }

  private send(ops: LiveOp[]) {
    if (!ops.length) return;
    this.outbox.push({ batchId: rid(), ops, keys: ops.map(opKey) });
    this.flush();
  }

  /** one request at a time, in order; everything waiting goes out together */
  private async flush() {
    if (this.posting || !this.clientId || !this.outbox.length) return;
    const batch: Batch = this.outbox.length === 1 ? this.outbox[0] : { batchId: rid(), ops: this.outbox.flatMap((b) => b.ops), keys: this.outbox.flatMap((b) => b.keys) };
    this.outbox = [];
    this.posting = batch;
    try {
      const res = await fetch(`/api/versions/${this.versionId}/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "ops", clientId: this.clientId, batchId: batch.batchId, ops: batch.ops }) });
      if (res.ok) {
        // waiting for the echo on the stream (it may already have arrived)
        if (this.posting === batch) this.unacked.push(batch);
      } else {
        const j = await res.json().catch(() => ({}));
        if (res.status === 403) {
          this.notify(j.error ?? "This version is read-only for you", "error");
          this.outbox = [];
        } else {
          // not connected (server restarted …): reconnect, resend after the hello
          this.outbox.unshift(batch);
          if (res.status === 409) this.reconnect();
          else setTimeout(() => this.flush(), 1500);
        }
      }
    } catch {
      this.outbox.unshift(batch);
      setTimeout(() => this.flush(), 1500);
    } finally {
      if (this.posting === batch) this.posting = null;
    }
    if (this.outbox.length) void this.flush();
  }

  private reconnect() {
    this.es?.close();
    this.clientId = null;
    this.base = null;
    this.connect();
  }

  /** send presence (throttled; drags and mode changes go out at once) */
  private presence(p: Record<string, unknown>, now = false) {
    Object.assign(this.pendingPresence, p);
    if (now) return void this.sendPresence();
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => this.sendPresence(), 70);
  }
  private sendPresence() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (!this.clientId) return;
    const p = this.pendingPresence;
    this.pendingPresence = {};
    const body = JSON.stringify({ kind: "presence", clientId: this.clientId, presence: p });
    if (body === this.lastPresence) return;
    this.lastPresence = body;
    fetch(`/api/versions/${this.versionId}/live`, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }

  /** follow someone: same sheet, same view */
  private follow(p: Peer | undefined) {
    if (!p) return;
    const st = useEditor.getState();
    const switched = !!p.pageId && p.pageId !== st.pageId && st.doc.pages.some((x) => x.id === p.pageId);
    if (switched) st.setPage(p.pageId!);
    const v = p.view;
    if (!v) return;
    const go = () => this.engine()?.centerOn({ x: v.cx, y: v.cy }, v.s);
    // after a sheet change the canvas fits the new sheet first; land on their view after that
    if (switched) setTimeout(go, 80);
    else go();
  }
}
