"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import type { Doc } from "@/core/model";
import { mkSel } from "@/core/ops";
import { useEditor, type VersionInfo } from "../store";
import type { Engine } from "../engine/Engine";
import { isTyping } from "../engine/Engine";
import { EditorCtx, type DialogName, type EditorUI } from "./context";
import { runCommand } from "./commands";
import { Header } from "./Header";
import { CanvasView } from "./CanvasView";
import { LeftPanel } from "./LeftPanel";
import { RightPanel } from "./RightPanel";
import { Dialogs } from "./dialogs/Dialogs";
import { TooltipProvider } from "@/components/ui/misc";
import { useBlockPlacement } from "./blocks";
import { LiveClient } from "../live/client";

export function EditorApp({ doc, version }: { doc: Doc; version: VersionInfo }) {
  const engine = useRef<Engine | null>(null);
  const [dialog, setDialog] = useState<{ name: DialogName; arg?: unknown } | null>(null);
  const [live, setLive] = useState("");
  const initialized = useRef(false);
  const liveRef = useRef<LiveClient | null>(null);

  if (!initialized.current) {
    useEditor.getState().init(doc, version);
    initialized.current = true;
  }

  const saving = useRef<Promise<void> | null>(null);
  const saveNow = useCallback(async () => {
    const s = useEditor.getState();
    if (!s.version?.editable || s.save === "saved" || s.save === "conflict") return;
    // in a live session the server saves; changes are already on their way
    if (liveRef.current) return;
    if (saving.current) return saving.current;
    const docAtSave = s.doc;
    s.setSave("saving");
    saving.current = (async () => {
      try {
        const json = JSON.stringify({ doc: docAtSave, baseRev: s.version!.docRev });
        const gz = json.length > 64 * 1024 ? await gzip(json) : null;
        const res = await fetch(`/api/versions/${s.version!.versionId}/doc`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...(gz ? { "content-encoding": "gzip" } : {}) },
          body: gz ?? json,
          keepalive: false,
        });
        const j = await res.json().catch(() => ({}));
        if (res.status === 409) {
          useEditor.getState().setSave("conflict", j.error ?? "This version was changed elsewhere.");
          return;
        }
        if (!res.ok) throw new Error(j.error ?? `Save failed (${res.status})`);
        const cur = useEditor.getState();
        cur.markSaved(j.rev);
        // edits made while the request was in flight keep the state dirty
        if (cur.doc !== docAtSave) cur.setSave("dirty");
      } catch (e) {
        useEditor.getState().setSave("error", (e as Error).message);
      } finally {
        saving.current = null;
      }
    })();
    return saving.current;
  }, []);

  const ui: EditorUI = useMemo(
    () => ({
      engine,
      openDialog: (name, arg) => setDialog({ name, arg }),
      toast: (msg, o) => {
        if (o?.tone === "error") toast.error(msg);
        else if (o?.undo)
          toast(msg, { action: { label: "Undo", onClick: () => useEditor.getState().undo() } });
        else toast(msg);
      },
      announce: (m) => setLive(m),
      saveNow,
    }),
    [saveNow],
  );

  // live collaboration: everyone in this version sees changes, cursors and selections instantly
  useEffect(() => {
    const s = useEditor.getState();
    if (!s.version?.versionId || typeof EventSource === "undefined") return;
    const c = new LiveClient(s.version.versionId, () => engine.current, (msg, tone) => (tone === "error" ? toast.error(msg) : toast(msg)), () => {
      // the live connection never came up (proxy, network): keep working with normal saving
      c.stop();
      liveRef.current = null;
      toast("Live collaboration is not available right now — your changes are saved normally.");
      const st = useEditor.getState();
      if (st.save === "dirty") void saveNow();
    });
    liveRef.current = c;
    c.start();
    // any own navigation stops following someone
    const stop = (e: Event) => {
      const st = useEditor.getState();
      if (!st.following) return;
      const host = engine.current?.host;
      if (host && e.target instanceof Node && host.contains(e.target)) st.set("following", null);
    };
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("wheel", stop, true);
    return () => {
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("wheel", stop, true);
      c.stop();
      liveRef.current = null;
    };
  }, []);

  // autosave: debounce after edits; flush on hide / unload
  const saveState = useEditor((s) => s.save);
  const docRef = useEditor((s) => s.doc);
  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void saveNow(), 1500);
    return () => clearTimeout(t);
  }, [saveState, docRef, saveNow]);
  useEffect(() => {
    const flush = () => {
      const s = useEditor.getState();
      if (liveRef.current) return;
      if (s.save === "dirty" && s.version?.editable) {
        navigator.sendBeacon?.(`/api/versions/${s.version.versionId}/doc?beacon=1`, new Blob([JSON.stringify({ doc: s.doc, baseRev: s.version.docRev })], { type: "application/json" }));
      }
    };
    const vis = () => document.visibilityState === "hidden" && flush();
    const before = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState();
      if (liveRef.current) {
        // live: only warn while changes are still on their way to the server
        if (liveRef.current.pending) e.preventDefault();
        return;
      }
      if (s.save === "dirty" || s.save === "saving" || s.save === "error") {
        flush();
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("beforeunload", before);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("beforeunload", before);
    };
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (document.querySelector("[role=dialog]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const eng = engine.current;
      const EDIT = new Set(["delete", "cut", "paste", "duplicate", "rotate", "rotateCcw", "mirror", "lock", "undo", "redo", "tool-wire", "tool-text", "connect"]);
      const run = (id: string) => {
        if (runCommand(id, ui)) return e.preventDefault();
        const st = useEditor.getState();
        if (EDIT.has(id) && st.version && !st.version.editable) {
          e.preventDefault();
          ui.toast(`${st.version.reason ?? "This version is read-only"}.`);
        }
      };
      if (mod) {
        if (k === "z" && e.shiftKey) return run("redo");
        if (k === "z") return run("undo");
        if (k === "y") return run("redo");
        if (k === "c") return run("copy");
        if (k === "x") return run("cut");
        if (k === "v") return run("paste");
        if (k === "d") return run("duplicate");
        if (k === "a") return run("selectAll");
        if (k === "s" && e.shiftKey) return run("styles");
        if (k === "s") {
          e.preventDefault();
          return void saveNow();
        }
        if (k === "k" || k === "p") {
          e.preventDefault();
          return setDialog({ name: "palette" });
        }
        if (k === "e") return run("export");
        if (k === "l") return run("lock");
        if (k === "f") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("volt:focus-search"));
          return;
        }
        if (e.key === "[") return run("navBack");
        if (k === "=" || k === "+") return run("zoomIn");
        if (k === "-") return run("zoomOut");
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") return run("navBack");
      if (e.altKey && e.code === "KeyR") {
        e.preventDefault();
        return run("rotateRefText");
      }
      if (e.key === "Escape") {
        if (useEditor.getState().following) return useEditor.getState().set("following", null);
        if (eng?.cancel()) return;
        const s = useEditor.getState();
        if (s.tool !== "select") return s.setTool("select");
        s.clearSel();
        s.set("highlight", null);
        return;
      }
      if (e.key === "Enter" && eng?.isBusy()) {
        eng.finishWireAsDangling();
        return;
      }
      if (e.key === "Backspace" && eng?.undoCorner()) return e.preventDefault();
      if (e.key === "Delete" || e.key === "Backspace") return run("delete");
      if (e.key === " " || e.key === "/") {
        if (eng?.toggleBend()) e.preventDefault();
        return;
      }
      if (e.key.startsWith("Arrow")) {
        const s = useEditor.getState();
        if (!s.version?.editable || !(s.sel.elements.length + s.sel.texts.length + s.sel.junctions.length + s.sel.wires.length)) return;
        e.preventDefault();
        const step = e.shiftKey ? 50 : s.doc.grid.size;
        const d = { x: e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, y: e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0 };
        import("@/core/ops").then(({ moveSelection, getPage }) => s.apply("Nudge", (dr) => moveSelection(dr, getPage(dr, s.pageId), s.sel, d)));
        return;
      }
      if (/^[1-5]$/.test(e.key) && useEditor.getState().tool === "shape") return run(`draw-${["rect", "ellipse", "line", "polygon", "polyline"][Number(e.key) - 1]}`);
      const map: Record<string, string> = { s: "tool-shape", v: "tool-select", w: e.shiftKey ? "connect" : "tool-wire", t: "tool-text", h: "tool-pan", c: "tool-comment", r: e.shiftKey ? "rotateCcw" : "rotate", x: "mirror", f: e.shiftKey ? "fitPage" : "fit", z: "zoomSel", "0": "zoom100", g: "grid", n: "selectNet", l: "followLabel", "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", "?": "shortcuts", "]": "scaleUp", "[": "scaleDown" };
      const id = map[e.key === "?" ? "?" : k];
      if (id) run(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui, saveNow]);

  useBlockPlacement(ui);

  // deep link: ?page=<pageId>&el=<elementId>
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const pg = q.get("page"), el = q.get("el");
    if (!pg && !el) return;
    const s = useEditor.getState();
    const page = s.doc.pages.find((p) => p.id === pg) ?? s.doc.pages.find((p) => p.elements.some((e) => e.id === el));
    if (!page) return;
    s.setPage(page.id);
    const t = setTimeout(() => {
      if (el && page.elements.some((e) => e.id === el)) {
        useEditor.getState().setSel(mkSel({ elements: [el] }));
        engine.current?.zoomToSelection();
      } else if (el && page.wires.some((w) => w.id === el)) {
        useEditor.getState().setSel(mkSel({ wires: [el] }));
        engine.current?.zoomToSelection();
      }
    }, 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <EditorCtx.Provider value={ui}>
      <TooltipProvider delayDuration={350}>
        <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
          <Header />
          <div className="flex min-h-0 flex-1">
            <LeftPanel />
            <main className="relative min-w-0 flex-1">
              <CanvasView />
            </main>
            <RightPanel />
          </div>
        </div>
        <Dialogs dialog={dialog} onClose={() => setDialog(null)} />
        <div aria-live="polite" className="sr-only">
          {live}
        </div>
        <Toaster position="bottom-center" toastOptions={{ className: "!text-xs !rounded-lg !border-border !bg-panel !text-fg" }} />
      </TooltipProvider>
    </EditorCtx.Provider>
  );
}

export { isTyping };

/** gzip a request body in the browser (large drawings save ~10× smaller); null when unsupported. */
async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}
