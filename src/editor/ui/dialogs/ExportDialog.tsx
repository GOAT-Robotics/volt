"use client";
import { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, FileCode2, FileDown, PenTool, Loader2, ClipboardList } from "lucide-react";
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
import { buildBom, bomToCsv, bomToXlsx, bomCell, BOM_COLUMNS, type BomGrouping } from "@/core/bom";
import { appendBomPages, appendTerminalPlanPages } from "@/core/render/bom-pdf";
import { collectStrips, terminalPlanRows } from "@/core/terminals";
import type { Doc, Page } from "@/core/model";
import type { Painter } from "@/core/render/painter";
import { rasterizeSvg } from "../logoUpload";

type Fmt = "pdf" | "svg" | "png" | "qet" | "dxf" | "bom";
const FORMATS: { id: Fmt; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "pdf", label: "PDF", icon: <FileText />, desc: "Vector, multi-page, print-ready" },
  { id: "svg", label: "SVG", icon: <PenTool />, desc: "Vector, one file per page" },
  { id: "png", label: "PNG", icon: <ImageIcon />, desc: "Raster image at chosen DPI" },
  { id: "qet", label: ".qet", icon: <FileCode2 />, desc: "Editable project file" },
  { id: "dxf", label: "DXF", icon: <FileDown />, desc: "CAD exchange (R12), per page" },
  { id: "bom", label: "BOM", icon: <ClipboardList />, desc: "Bill of materials: Excel, CSV, PDF" },
];

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "export";

export function ExportDialog({ onClose, arg }: { onClose: () => void; arg?: { format?: "bom" } }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const v = useEditor((s) => s.version);
  const comments = useEditor((s) => s.comments);
  const ui = useEditorUI();
  const [fmt, setFmt] = useState<Fmt>(arg?.format ?? "pdf");
  const [bomFile, setBomFile] = useState<"xlsx" | "csv" | "pdf">("xlsx");
  const [grouping, setGrouping] = useState<BomGrouping>("part");
  const [bomInPdf, setBomInPdf] = useState(false);
  const [termsInPdf, setTermsInPdf] = useState(false);
  const hasTerminals = useMemo(() => fmt === "pdf" && collectStrips(doc).some((x) => x.rows.length), [fmt, doc]);
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
  const bom = useMemo(() => (fmt === "bom" || (fmt === "pdf" && bomInPdf) ? buildBom(doc, { pages, grouping }) : null), [fmt, bomInPdf, doc, pages, grouping]);
  const bomMeta = () => ({
    title: `${v?.projectName ?? doc.meta.title}${v ? ` — v${v.label}` : ""}`,
    subtitle: [v ? `Version ${v.label} (${v.status.replace("_", " ").toLowerCase()})` : "", `${pages.length === sorted.length ? "All sheets" : `Sheets ${pages.map((p) => sorted.indexOf(p) + 1).join(", ")}`}`, new Date().toISOString().slice(0, 10)].filter(Boolean).join(" · "),
  });
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

  const appendComments = async (pdf: import("pdf-lib").PDFDocument, fonts: { regular: import("pdf-lib").PDFFont; bold: import("pdf-lib").PDFFont }) => {
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
          rasterizeSvg,
          append: async (pdf, fonts) => {
            if (bomInPdf && bom) appendBomPages(pdf, fonts, bom, bomMeta());
            if (termsInPdf) appendTerminalPlanPages(pdf, fonts, terminalPlanRows(doc), bomMeta());
            if (markup) await appendComments(pdf, fonts);
          },
        });
        downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
      } else if (fmt === "bom") {
        const b = bom ?? buildBom(doc, { pages, grouping });
        if (bomFile === "csv") downloadBlob(new Blob([bomToCsv(b)], { type: "text/csv;charset=utf-8" }), `${base}_BOM.csv`);
        else if (bomFile === "xlsx") downloadBlob(new Blob([bomToXlsx(b, bomMeta()) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}_BOM.xlsx`);
        else {
          const { PDFDocument, StandardFonts } = await import("pdf-lib");
          const pdf = await PDFDocument.create();
          pdf.setTitle(`Bill of materials — ${bomMeta().title}`);
          pdf.setCreator("Volt");
          const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
          appendBomPages(pdf, fonts, b, bomMeta());
          downloadBlob(new Blob([(await pdf.save()) as BlobPart], { type: "application/pdf" }), `${base}_BOM.pdf`);
        }
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
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
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
            {fmt === "bom" && (
              <>
                <Field label="Group">
                  <NativeSelect value={grouping} onChange={(e) => setGrouping(e.target.value as BomGrouping)}>
                    <option value="part">By part number (purchasing)</option>
                    <option value="location">By location, then part</option>
                    <option value="component">One line per component</option>
                  </NativeSelect>
                </Field>
                <Field label="File">
                  <NativeSelect value={bomFile} onChange={(e) => setBomFile(e.target.value as typeof bomFile)}>
                    <option value="xlsx">Excel (.xlsx)</option>
                    <option value="csv">CSV</option>
                    <option value="pdf">PDF table</option>
                  </NativeSelect>
                </Field>
              </>
            )}
            {fmt !== "bom" && (
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <Checkbox checked={meta} onCheckedChange={(x) => setMeta(!!x)} /> Include version & status in title block fields
              </label>
            )}
            {fmt === "pdf" && (
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <Checkbox checked={bomInPdf} onCheckedChange={(x) => setBomInPdf(!!x)} /> Append the bill of materials (and cable list) after the drawings
              </label>
            )}
            {hasTerminals && (
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <Checkbox checked={termsInPdf} onCheckedChange={(x) => setTermsInPdf(!!x)} /> Append the terminal plan (one table per terminal strip)
              </label>
            )}
            {fmt === "bom" && bom && <BomPreview bom={bom} />}
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

function BomPreview({ bom }: { bom: ReturnType<typeof buildBom> }) {
  const cols = BOM_COLUMNS.filter((c) => c.key !== "supplier" && c.key !== "location" && c.key !== "unit");
  return (
    <div className="col-span-2 space-y-1.5">
      <p className="text-2xs text-muted">
        {bom.rows.length} line{bom.rows.length === 1 ? "" : "s"} · {bom.components} component{bom.components === 1 ? "" : "s"}
        {bom.cables.length ? ` · ${bom.cables.length} cable${bom.cables.length === 1 ? "" : "s"}` : ""}
        {bom.excluded ? ` · ${bom.excluded} left out (Bill of materials off)` : ""}
        {bom.missingPart ? <span className="text-warning"> · {bom.missingPart} without part number</span> : null}
      </p>
      <div className="max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full text-2xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-border text-left text-subtle">
              {cols.map((c) => (
                <th key={c.key} className="px-1.5 py-1 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bom.rows.slice(0, 200).map((r) => (
              <tr key={r.item} className="border-b border-border/60 last:border-0">
                {cols.map((c) => (
                  <td key={c.key} className={cn("px-1.5 py-0.5 align-top", c.key === "partNumber" && !r.partNumber && "text-warning", (c.key === "item" || c.key === "qty") && "tabular text-right")}>
                    {c.key === "partNumber" && !r.partNumber ? "—" : bomCell(r, c.key)}
                  </td>
                ))}
              </tr>
            ))}
            {!bom.rows.length && (
              <tr>
                <td colSpan={cols.length} className="px-2 py-3 text-center text-subtle">
                  No parts on the selected pages.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] leading-snug text-subtle">
        Parts come from each component&apos;s Name, Rating, Part number and Manufacturer. Instances with the same reference count once; set Quantity for multiples, or turn Bill of materials off in the inspector to leave a component out.
      </p>
    </div>
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
