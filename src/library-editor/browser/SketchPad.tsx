"use client";
/**
 * Free drawing pad (tldraw-style, self-contained): pen, line, rectangle, ellipse, eraser, undo /
 * redo, clear. Shift straightens lines (45°) and squares shapes. Exports a clean PNG for the AI.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Circle, Eraser, Minus, Pencil, Redo2, Square, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

type Tool = "pen" | "line" | "rect" | "ellipse" | "eraser";
type Pt = { x: number; y: number };
type Stroke = { tool: Exclude<Tool, "eraser">; pts: Pt[]; w: number };
export type SketchPadHandle = { toPng: (maxW?: number) => string | null; isEmpty: () => boolean; clear: () => void };

const W = 640, H = 420;
const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "pen", label: "Pen", key: "P", icon: <Pencil /> },
  { id: "line", label: "Line (Shift: 45°)", key: "L", icon: <Minus /> },
  { id: "rect", label: "Rectangle (Shift: square)", key: "R", icon: <Square /> },
  { id: "ellipse", label: "Ellipse (Shift: circle)", key: "O", icon: <Circle /> },
  { id: "eraser", label: "Eraser (removes strokes)", key: "E", icon: <Eraser /> },
];

function draw(ctx: CanvasRenderingContext2D, s: Stroke, k = 1) {
  ctx.lineWidth = s.w * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#111827";
  ctx.beginPath();
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  if (s.tool === "pen") {
    ctx.moveTo(a.x * k, a.y * k);
    for (let i = 1; i < s.pts.length - 1; i++) {
      const p = s.pts[i], q = s.pts[i + 1];
      ctx.quadraticCurveTo(p.x * k, p.y * k, ((p.x + q.x) / 2) * k, ((p.y + q.y) / 2) * k);
    }
    ctx.lineTo(b.x * k, b.y * k);
    if (s.pts.length === 1) ctx.lineTo(a.x * k + 0.1, a.y * k);
  } else if (s.tool === "line") {
    ctx.moveTo(a.x * k, a.y * k);
    ctx.lineTo(b.x * k, b.y * k);
  } else if (s.tool === "rect") {
    ctx.rect(Math.min(a.x, b.x) * k, Math.min(a.y, b.y) * k, Math.abs(b.x - a.x) * k, Math.abs(b.y - a.y) * k);
  } else {
    ctx.ellipse(((a.x + b.x) / 2) * k, ((a.y + b.y) / 2) * k, (Math.abs(b.x - a.x) / 2) * k, (Math.abs(b.y - a.y) / 2) * k, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function nearStroke(s: Stroke, p: Pt, r: number) {
  const segs: [Pt, Pt][] = [];
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  if (s.tool === "pen") for (let i = 0; i < s.pts.length - 1; i++) segs.push([s.pts[i], s.pts[i + 1]]);
  else if (s.tool === "line") segs.push([a, b]);
  else if (s.tool === "rect") {
    const c = { x: b.x, y: a.y }, d = { x: a.x, y: b.y };
    segs.push([a, c], [c, b], [b, d], [d, a]);
  } else {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2 || 1, ry = Math.abs(b.y - a.y) / 2 || 1;
    const v = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
    return Math.abs(v - 1) * Math.min(rx, ry) < r;
  }
  if (s.pts.length === 1) return Math.hypot(p.x - a.x, p.y - a.y) < r;
  return segs.some(([u, w]) => {
    const dx = w.x - u.x, dy = w.y - u.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / L));
    return Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy)) < r;
  });
}

export const SketchPad = forwardRef<SketchPadHandle, { className?: string }>(function SketchPad({ className }, ref) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redo, setRedo] = useState<Stroke[][]>([]);
  const [width, setWidth] = useState(3);
  const cur = useRef<Stroke | null>(null);
  const hist = useRef<Stroke[][]>([]);

  const paint = useCallback(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== W * dpr) (c.width = W * dpr), (c.height = H * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#e4e4e7";
    for (let x = 20; x < W; x += 20) for (let y = 20; y < H; y += 20) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    for (const s of strokes) draw(ctx, s);
    if (cur.current) draw(ctx, cur.current);
  }, [strokes]);
  useEffect(paint, [paint]);

  const commit = (next: Stroke[]) => {
    hist.current.push(strokes);
    setRedo([]);
    setStrokes(next);
  };
  const undo = () => {
    const prev = hist.current.pop();
    if (!prev) return;
    setRedo((r) => [...r, strokes]);
    setStrokes(prev);
  };
  const redoOne = () => {
    const n = redo[redo.length - 1];
    if (!n) return;
    hist.current.push(strokes);
    setRedo(redo.slice(0, -1));
    setStrokes(n);
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.length === 0,
    clear: () => commit([]),
    toPng: (maxW = 1024) => {
      if (!strokes.length) return null;
      // crop to the drawing with a margin, white background, no grid
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of strokes) for (const p of s.pts) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
      const m = 24;
      (x0 -= m), (y0 -= m), (x1 += m), (y1 += m);
      const k = Math.min(maxW / (x1 - x0), maxW / (y1 - y0), 3);
      const out = document.createElement("canvas");
      out.width = Math.round((x1 - x0) * k);
      out.height = Math.round((y1 - y0) * k);
      const ctx = out.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.translate(-x0 * k, -y0 * k);
      for (const s of strokes) draw(ctx, s, k);
      return out.toDataURL("image/png");
    },
  }));

  const pos = (e: React.PointerEvent): Pt => {
    const r = cv.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const constrain = (a: Pt, b: Pt, shift: boolean, t: Tool): Pt => {
    if (!shift) return b;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (t === "line") {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy);
      return { x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r };
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * d, y: a.y + Math.sign(dy || 1) * d };
  };
  const down = (e: React.PointerEvent) => {
    cv.current!.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (tool === "eraser") {
      const keep = strokes.filter((s) => !nearStroke(s, p, 8));
      if (keep.length !== strokes.length) commit(keep);
      cur.current = { tool: "pen", pts: [], w: 0 };
      return;
    }
    cur.current = { tool, pts: tool === "pen" ? [p] : [p, p], w: width };
    paint();
  };
  const move = (e: React.PointerEvent) => {
    const s = cur.current;
    if (!s) return;
    const p = pos(e);
    if (tool === "eraser") {
      const keep = strokes.filter((x) => !nearStroke(x, p, 8));
      if (keep.length !== strokes.length) setStrokes(keep);
      return;
    }
    if (s.tool === "pen") {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5) s.pts.push(p);
    } else s.pts[1] = constrain(s.pts[0], p, e.shiftKey, s.tool);
    paint();
  };
  const up = () => {
    const s = cur.current;
    cur.current = null;
    if (!s || tool === "eraser" || !s.pts.length) return;
    const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
    if (s.tool !== "pen" && Math.hypot(b.x - a.x, b.y - a.y) < 2) return paint();
    commit([...strokes, s]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoOne();
        else undo();
        return;
      }
      const m = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (m && !e.metaKey && !e.ctrlKey) setTool(m.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1">
        {TOOLS.map((t) => (
          <Tip key={t.id} content={t.label} shortcut={t.key}>
            <Button type="button" variant="tool" size="icon-sm" active={tool === t.id} aria-pressed={tool === t.id} aria-label={t.label} onClick={() => setTool(t.id)}>
              {t.icon}
            </Button>
          </Tip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {[2, 3, 5].map((w) => (
          <button key={w} type="button" onClick={() => setWidth(w)} className={cn("flex size-7 items-center justify-center rounded", width === w ? "bg-hover" : "hover:bg-hover")} aria-label={`Stroke ${w}`}>
            <span className="rounded-full bg-fg" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <Tip content="Undo" shortcut="⌘Z">
            <Button type="button" variant="ghost" size="icon-sm" onClick={undo} disabled={!hist.current.length} aria-label="Undo">
              <Undo2 />
            </Button>
          </Tip>
          <Tip content="Redo" shortcut="⇧⌘Z">
            <Button type="button" variant="ghost" size="icon-sm" onClick={redoOne} disabled={!redo.length} aria-label="Redo">
              <Redo2 />
            </Button>
          </Tip>
          <Tip content="Clear">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => commit([])} disabled={!strokes.length} aria-label="Clear">
              <Trash2 />
            </Button>
          </Tip>
        </span>
      </div>
      <canvas
        ref={cv}
        style={{ aspectRatio: `${W} / ${H}` }}
        className={cn("w-full touch-none rounded-lg border border-border bg-white", tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label="Sketch area"
      />
    </div>
  );
});
