"use client";
import { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, FileCode2, FileDown, PenTool, Loader2 } from "lucide-react";
import { zipSync, strToU8 } from "fflate";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Field } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { cn, downloadBlob } from "@/lib/utils";
import { exportPdf, PAPER } from "@/core/render/pdf";
import { pageToSvg } from "@/core/render/svg";
import { pageToDxf } from "@/core/render/dxf";
import { CanvasPainter, measureText } from "@/core/render/canvas";
import { drawPage, pageGeometry } from "@/core/render/scene";
import { PathBuilder } from "@/core/render/painter";
import { exportQet } from "@/core/qet/project";
import type { Doc, Page } from "@/core/model";
import type { Painter } from "@/core/render/painter";

type Fmt = "pdf" | "svg" | "png" | "qet" | "dxf";
const FORMATS: { id: Fmt; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "pdf", label: "PDF", icon: <FileText />, desc: "Vector, multi-page, print-ready" },
  { id: "svg", label: "SVG", icon: <PenTool />, desc: "Vector, one file per page" },
  { id: "png", label: "PNG", icon: <ImageIcon />, desc: "Raster image at chosen DPI" },
  { id: "qet", label: ".qet", icon: <FileCode2 />, desc: "Editable project file" },
  { id: "dxf", label: "DXF", icon: <FileDown />, desc: "CAD exchange (R12), per page" },
];

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "export";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const v = useEditor((s) => s.version);
  const comments = useEditor((s) => s.comments);
  const ui = useEditorUI();
  const [fmt, setFmt] = useState<Fmt>("pdf");
  const [range, setRange] = useState<"current" | "all" | "custom">("all");
  const [custom, setCustom] = useState("1-");
  const [paper, setPaper] = useState<keyof typeof PAPER | "fit">("A3");
  const [dpi, setDpi] = useState(200);
  const [markup, setMarkup] = useState(false);
  const [meta, setMeta] = useState(true);
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(() => [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order), [doc.pages]);
  const pages = useMemo(() => {
    if (range === "current") return sorted.filter((p) => p.id === pageId);
    if (range === "all") return sorted;
    const set = new Set<number>();
    for (const part of custom.split(",")) {
      const m = /^\s*(\d*)\s*(-)?\s*(\d*)\s*$/.exec(part);
      if (!m) continue;
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? (m[3] ? Number(m[3]) : sorted.length) : a;
      for (let i = a; i <= b; i++) set.add(i);
    }
    return sorted.filter((_, i) => set.has(i + 1));
  }, [range, custom, sorted, pageId]);
  // the original project file (for lossless .qet export) stays on the server until it is needed
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (fmt !== "qet" || !doc.qet?.hasSource || source !== null || !v?.versionId) return;
    let live = true;
    fetch(`/api/versions/${v.versionId}/source`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setSource(t))
      .catch(() => live && setSource(""));
    return () => {
      live = false;
    };
  }, [fmt, doc.qet?.hasSource, source, v?.versionId]);
  const qetDoc = useMemo(() => (doc.qet?.hasSource && source ? { ...doc, qet: { ...doc.qet, source } } : doc), [doc, source]);
  const sourcePending = fmt === "qet" && !!doc.qet?.hasSource && source === null;
  const qetReport = useMemo(() => (fmt === "qet" && !sourcePending ? safeReport(qetDoc) : null), [fmt, qetDoc, sourcePending]);
  const base = safe(`${v?.projectName ?? doc.meta.title}_v${v?.label ?? ""}`);
  const extraFields = meta && v ? { status: v.status, versionstatus: v.status } : undefined;

  const overlay = (p: Painter, page: Page) => {
    if (!markup) return;
    const list = comments.filter((c) => c.pageId === page.id && c.anchor);
    list.forEach((c, i) => {
      const a = c.anchor!;
      p.fill(new PathBuilder().E(a.x + 6, a.y - 6, 6, 6).build(), "#9333ea");
      p.text({ text: String(i + 1), x: a.x + 6, y: a.y - 6, size: 7, font: "Helvetica", color: "#ffffff", align: "center", baseline: "middle", weight: 700 });
    });
  };

  const run = async () => {
    if (!pages.length) return ui.toast("No pages selected", { tone: "error" });
    setBusy(true);
    try {
      if (fmt === "pdf") {
        const bytes = await exportPdf(doc, {
          pages,
          paper,
          title: `${doc.meta.title}${v ? ` — v${v.label}` : ""}`,
          subject: v ? `Version ${v.label} (${v.status})` : undefined,
          author: v?.userName,
          version: meta ? v?.label : undefined,
          keywords: ["Volt", "electrical diagram", ...(v ? [`version:${v.label}`, `status:${v.status}`] : [])],
          drawOpts: { extraFields },
          overlay,
          append: markup
            ? async (pdf, fonts) => {
                const list = comments.filter((c) => pages.some((p) => p.id === c.pageId));
                if (!list.length) return;
                let pg = pdf.addPage([595.28, 841.89]);
                let y = 800;
                pg.drawText("Review comments", { x: 40, y, size: 14, font: fonts.bold });
                y -= 24;
                for (const [i, c] of list.entries()) {
                  const lines = wrap(`${i + 1}. [${c.status}] ${c.author}: ${c.body}`.replace(/[^\x20-\x7E -ÿ]/g, "?"), 95);
                  for (const l of lines) {
                    if (y < 40) {
                      pg = pdf.addPage([595.28, 841.89]);
                      y = 800;
                    }
                    pg.drawText(l, { x: 40, y, size: 9, font: fonts.regular });
                    y -= 13;
                  }
                  y -= 4;
                }
              }
            : undefined,
        });
        downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
      } else if (fmt === "svg") {
        const files = pages.map((p, i) => [`${String(i + 1).padStart(2, "0")}_${safe(p.title)}.svg`, pageToSvg(doc, p, { measure: measureText, background: "#ffffff", version: meta ? v?.label : undefined, extraFields })] as const);
        if (files.length === 1) downloadBlob(new Blob([files[0][1]], { type: "image/svg+xml" }), `${base}_${files[0][0]}`);
        else downloadBlob(new Blob([zipSync(Object.fromEntries(files.map(([n, s]) => [n, strToU8(s)])))], { type: "application/zip" }), `${base}_svg.zip`);
      } else if (fmt === "png") {
        const out: [string, Uint8Array][] = [];
        for (const [i, p] of pages.entries()) out.push([`${String(i + 1).padStart(2, "0")}_${safe(p.title)}.png`, await renderPng(doc, p, dpi, meta ? v?.label : undefined, overlay)]);
        if (out.length === 1) downloadBlob(new Blob([out[0][1] as BlobPart], { type: "image/png" }), `${base}_${out[0][0]}`);
        else downloadBlob(new Blob([zipSync(Object.fromEntries(out))], { type: "application/zip" }), `${base}_png.zip`);
      } else if (fmt === "qet") {
        const { xml } = exportQet(qetDoc);
        downloadBlob(new Blob([xml], { type: "application/xml" }), `${base}.qet`);
      } else if (fmt === "dxf") {
        const files = pages.map((p, i) => [`${String(i + 1).padStart(2, "0")}_${safe(p.title)}.dxf`, pageToDxf(doc, p)] as const);
        if (files.length === 1) downloadBlob(new Blob([files[0][1]], { type: "application/dxf" }), `${base}_${files[0][0]}`);
        else downloadBlob(new Blob([zipSync(Object.fromEntries(files.map(([n, s]) => [n, strToU8(s)])))], { type: "application/zip" }), `${base}_dxf.zip`);
      }
      if (v) fetch(`/api/versions/${v.versionId}/export-log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: fmt, pages: pages.length, markup }) }).catch(() => {});
      ui.toast("Export ready");
      onClose();
    } catch (e) {
      console.error(e);
      ui.toast(`Export failed: ${(e as Error).message}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Export" description={v ? `Version ${v.label} · ${v.status.replace("_", " ").toLowerCase()}` : undefined} wide>
        <div className="grid grid-cols-5 gap-1.5">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFmt(f.id)}
              className={cn("flex flex-col items-center gap-1 rounded-lg border p-2.5 text-center [&_svg]:size-4", fmt === f.id ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-hover")}
              aria-pressed={fmt === f.id}
            >
              {f.icon}
              <span className="text-xs font-medium">{f.label}</span>
              <span className="text-[10px] leading-tight text-subtle">{f.desc}</span>
            </button>
          ))}
        </div>
        {fmt !== "qet" ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Pages">
              <div className="flex gap-1">
                <NativeSelect value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
                  <option value="all">All pages ({sorted.length})</option>
                  <option value="current">Current page</option>
                  <option value="custom">Range…</option>
                </NativeSelect>
                {range === "custom" && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="1-3, 5" className="w-28" />}
              </div>
            </Field>
            {fmt === "pdf" && (
              <Field label="Paper">
                <NativeSelect value={paper} onChange={(e) => setPaper(e.target.value as typeof paper)}>
                  <option value="fit">Fit to drawing</option>
                  {Object.keys(PAPER).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {fmt === "png" && (
              <Field label="Resolution">
                <NativeSelect value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                  {[96, 150, 200, 300, 600].map((d) => (
                    <option key={d} value={d}>
                      {d} dpi
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <label className="col-span-2 flex items-center gap-2 text-xs">
              <Checkbox checked={meta} onCheckedChange={(x) => setMeta(!!x)} /> Include version & status in title block fields
            </label>
            {(fmt === "pdf" || fmt === "png") && (
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <Checkbox checked={markup} onCheckedChange={(x) => setMarkup(!!x)} /> Include review markup{fmt === "pdf" ? " and a comment summary page" : ""}
              </label>
            )}
            <p className="col-span-2 text-2xs text-subtle">{pages.length} page{pages.length === 1 ? "" : "s"} selected.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-muted">Exports the whole project, including content from the original file that Volt doesn’t edit.</p>
            {qetReport && (
              <ul className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2 text-2xs">
                {qetReport.items.filter((i) => i.level !== "supported").length === 0 && <li className="text-success">Everything in this project is written natively.</li>}
                {qetReport.items
                  .filter((i) => i.level !== "supported")
                  .map((i, k) => (
                    <li key={k} className={i.level === "unsupported" ? "text-danger" : i.level === "degraded" ? "text-warning" : "text-muted"}>
                      <b className="uppercase">{i.level}</b> · {i.area}: {i.message}
                      {i.count ? ` (${i.count})` : ""}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={busy || sourcePending}>
            {busy ? <Loader2 className="animate-spin" /> : <FileDown />} Export {FORMATS.find((f) => f.id === fmt)?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function safeReport(doc: Doc) {
  try {
    return exportQet(doc).report;
  } catch (e) {
    return { items: [{ level: "unsupported" as const, area: "export", message: (e as Error).message, count: undefined as number | undefined }] };
  }
}

function wrap(s: string, n: number) {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/)) {
    if ((cur + " " + w).trim().length > n) {
      out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

async function renderPng(doc: Doc, page: Page, dpi: number, version: string | undefined, overlay: (p: Painter, page: Page) => void): Promise<Uint8Array> {
  const r = pageGeometry(doc, page).total;
  const pad = 10;
  const scale = dpi / 96;
  const w = Math.min(16000, Math.ceil((r.w + pad * 2) * scale));
  const h = Math.min(16000, Math.ceil((r.h + pad * 2) * scale));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const p = new CanvasPainter(ctx, [scale, 0, 0, scale, (pad - r.x) * scale, (pad - r.y) * scale], 1);
  drawPage(p, { doc, page, lod: 100, version });
  overlay(p, page);
  const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res) => (canvas as HTMLCanvasElement).toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
