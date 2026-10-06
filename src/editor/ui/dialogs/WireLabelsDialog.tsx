"use client";
/**
 * Harness wire labels: choose wires (selection, sheet, cable or all), content and medium, preview
 * every label, then print directly on a Brother P-touch (USB or Bluetooth) or download a PDF / CSV.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, Usb, Bluetooth, FileDown, Sheet, FileText, Unplug, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Checkbox, Spinner, Switch } from "@/components/ui/misc";
import { MEDIA, labelRecords, layoutLabel, type LabelContent, type LabelLayout, type LabelRecord } from "@/core/labels";
import { encodeJob, mmToDots, MEDIA_TYPE_NAME, type PtStatus } from "@/core/ptouch";
import { canvasMeasure, labelBitmap, labelCanvas } from "../../labels/render";
import { labelsCsv, sheetPdf, tapePdf } from "../../labels/export";
import { connectSerial, connectUsb, serialSupported, usbSupported, type PrinterLink } from "../../labels/printer";
import { cn, downloadBlob } from "@/lib/utils";

type Scope = "selection" | "page" | "all" | "cable";
type Settings = { flagTurn: boolean; content: LabelContent; mediaId: string; length: number; wireDiameter: number; repeat: number; margin: number; sort: "number" | "sheet" | "device"; autoCut: boolean; halfCut: boolean; flip: boolean; offsetPins: number; feedMm: number };
const DEFAULTS: Settings = {
  flagTurn: false,
  content: { perEnd: true, detail: "route", conductor: false, includeUnnumbered: false },
  mediaId: "hse-231",
  length: 0,
  wireDiameter: 2.5,
  repeat: 2,
  margin: 2,
  sort: "number",
  autoCut: true,
  halfCut: false,
  flip: false,
  offsetPins: 0,
  feedMm: 2,
};
const KEY = "volt.wireLabels";
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULTS, ...s, content: { ...DEFAULTS.content, ...(s.content ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

// one connected printer per editor session
let shared: PrinterLink | null = null;

export function WireLabelsDialog({ onClose, arg }: { onClose: () => void; arg?: { scope?: Scope } }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const selWires = useEditor((s) => s.sel.wires);
  const ui = useEditorUI();
  const [st, setSt] = useState<Settings>(loadSettings);
  const [scope, setScope] = useState<Scope>(arg?.scope ?? (selWires.length ? "selection" : "all"));
  const [cable, setCable] = useState(doc.cables?.[0]?.tag ?? "");
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = all labels
  const [link, setLink] = useState<PrinterLink | null>(shared);
  const [status, setStatus] = useState<PtStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {}
  }, [st]);
  const up = (p: Partial<Settings>) => setSt((s) => ({ ...s, ...p }));
  const upC = (p: Partial<LabelContent>) => setSt((s) => ({ ...s, content: { ...s.content, ...p } }));
  const media = MEDIA.find((m) => m.id === st.mediaId) ?? MEDIA[0];
  const layout: LabelLayout = { media, length: st.length, wireDiameter: st.wireDiameter, repeat: media.kind === "wrap" ? Math.max(2, st.repeat) : media.kind === "flag" ? 1 : st.repeat, margin: st.margin, flagTurn: st.flagTurn };

  const recs = useMemo(
    () =>
      labelRecords(doc, {
        wireIds: scope === "selection" ? new Set(selWires) : undefined,
        pageIds: scope === "page" ? new Set([pageId]) : undefined,
        cable: scope === "cable" ? cable : undefined,
        content: st.content,
        sort: st.sort,
      }),
    [doc, scope, selWires, pageId, cable, st.content, st.sort],
  );
  useEffect(() => setPicked(null), [recs]);
  const chosen = useMemo(() => (picked ? recs.filter((r) => picked.has(r.key)) : recs), [recs, picked]);
  const laid = (rs: LabelRecord[]) => rs.map((r) => layoutLabel(r, st.content, layout, canvasMeasure));
  const unnumbered = useMemo(() => {
    const ids = new Set<string>();
    for (const p of doc.pages) for (const w of p.wires) if (!w.label && (scope !== "page" || p.id === pageId) && (scope !== "selection" || selWires.includes(w.id))) ids.add(w.id);
    return ids.size;
  }, [doc, scope, pageId, selWires]);
  const totalLen = useMemo(() => laid(chosen).reduce((a, l) => a + l.length + st.feedMm * 2, 0), [chosen, st, media]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = (doc.meta.title || "project").replace(/[\\/:*?"<>|]+/g, "_");

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      if ((e as Error).name !== "NotFoundError") ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const connect = (kind: "usb" | "serial") =>
    run("connect", async () => {
      await shared?.close().catch(() => {});
      const l = kind === "usb" ? await connectUsb() : await connectSerial();
      shared = l;
      setLink(l);
      const s = await l.status().catch(() => null);
      setStatus(s);
      if (s?.mediaWidth) {
        // pick the loaded medium when the current one does not match
        const heat = s.mediaType === 0x11 || s.mediaType === 0x17;
        if (Math.round(media.brotherWidth) !== s.mediaWidth || (media.kind === "heatshrink") !== heat) {
          const m = MEDIA.find((x) => x.brotherWidth === s.mediaWidth && (x.kind === "heatshrink") === heat);
          if (m) up({ mediaId: m.id });
        }
      }
    });
  const disconnect = () => run("connect", async () => {
    await shared?.close();
    shared = null;
    setLink(null);
    setStatus(null);
  });
  const refresh = () => run("status", async () => setStatus((await link?.status()) ?? null));
  const print = (rs: LabelRecord[]) =>
    run("print", async () => {
      if (!link) throw new Error("Connect the printer first");
      const s = await link.status().catch(() => null);
      if (s) {
        setStatus(s);
        if (s.errors.length) throw new Error(`Printer: ${s.errors.join(", ")}`);
        const heat = s.mediaType === 0x11 || s.mediaType === 0x17;
        if (s.mediaWidth && (s.mediaWidth !== media.brotherWidth || heat !== (media.kind === "heatshrink"))) throw new Error(`The printer has ${s.mediaWidth} mm ${MEDIA_TYPE_NAME[s.mediaType] ?? "media"} loaded, not ${media.name}`);
      }
      const bitmaps = laid(rs).map((l) => labelBitmap(l, media));
      // send in batches so long jobs don't overflow the printer's buffer
      for (let i = 0; i < bitmaps.length; i += 20) {
        const job = encodeJob({ labels: bitmaps.slice(i, i + 20), mediaType: media.brotherType, widthMm: media.brotherWidth, autoCut: st.autoCut, halfCut: st.halfCut, feedDots: mmToDots(st.feedMm), flip: st.flip, offsetPins: st.offsetPins });
        await link.send(job);
      }
      ui.toast(`${rs.length} label${rs.length === 1 ? "" : "s"} sent to ${link.name}`);
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Wire labels" description="Markers for both ends of every wire — for harness and cabinet building. Print directly on a Brother P-touch, or download a PDF / CSV." wide="xl">
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          {/* settings */}
          <div className="space-y-3 text-xs">
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Wires</legend>
              <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Which wires">
                <option value="selection" disabled={!selWires.length}>
                  Selected wires ({selWires.length})
                </option>
                <option value="page">This sheet</option>
                <option value="all">Whole project</option>
                <option value="cable" disabled={!doc.cables?.length}>
                  One cable / harness
                </option>
              </NativeSelect>
              {scope === "cable" && (
                <NativeSelect value={cable} onChange={(e) => setCable(e.target.value)} aria-label="Cable">
                  {(doc.cables ?? []).map((c) => (
                    <option key={c.tag} value={c.tag}>
                      {c.tag} {c.type ? `· ${c.type}` : ""}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <NativeSelect value={st.sort} onChange={(e) => up({ sort: e.target.value as Settings["sort"] })} aria-label="Order">
                <option value="number">Order: wire number</option>
                <option value="sheet">Order: sheet, then number</option>
                <option value="device">Order: device / terminal</option>
              </NativeSelect>
              {unnumbered > 0 && (
                <p className="flex items-start gap-1 text-2xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  {unnumbered} wire{unnumbered === 1 ? " has" : "s have"} no number.{" "}
                  <button className="underline" onClick={() => ui.openDialog("wireNumbers")}>
                    Number wires…
                  </button>
                </p>
              )}
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Content</legend>
              <label className="flex items-center gap-2">
                <Switch checked={st.content.perEnd} onCheckedChange={(v) => upC({ perEnd: v })} /> One label per wire end
              </label>
              <NativeSelect value={st.content.detail} onChange={(e) => upC({ detail: e.target.value as LabelContent["detail"] })} aria-label="Second line">
                <option value="route">Second line: this end → other end</option>
                <option value="destination">Second line: destination only</option>
                <option value="here">Second line: this terminal</option>
                <option value="none">Wire number only</option>
              </NativeSelect>
              <label className="flex items-center gap-2">
                <Checkbox checked={st.content.conductor} onCheckedChange={(v) => upC({ conductor: !!v })} /> Add colour and cross-section
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={st.content.includeUnnumbered} onCheckedChange={(v) => upC({ includeUnnumbered: !!v })} /> Include wires without a number
              </label>
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Label</legend>
              <NativeSelect value={st.mediaId} onChange={(e) => up({ mediaId: e.target.value })} aria-label="Label medium">
                {MEDIA.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.wires ? ` (${m.wires})` : ""}
                  </option>
                ))}
              </NativeSelect>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-0.5">
                  <span className="text-2xs text-muted">Length mm (0 = fit)</span>
                  <Input type="number" min={0} max={200} value={st.length} onChange={(e) => up({ length: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                {media.kind === "flag" || media.kind === "wrap" ? (
                  <label className="space-y-0.5">
                    <span className="text-2xs text-muted">Wire Ø mm</span>
                    <Input type="number" min={0.5} max={30} step={0.1} value={st.wireDiameter} onChange={(e) => up({ wireDiameter: Math.max(0.5, Number(e.target.value) || 2) })} />
                  </label>
                ) : null}
                {media.kind !== "flag" && (
                  <label className="space-y-0.5">
                    <span className="text-2xs text-muted">Text repeated</span>
                    <Input type="number" min={1} max={6} value={st.repeat} onChange={(e) => up({ repeat: Math.min(6, Math.max(1, Number(e.target.value) || 1)) })} />
                  </label>
                )}
                <label className="space-y-0.5">
                  <span className="text-2xs text-muted">End margin mm</span>
                  <Input type="number" min={0} max={20} step={0.5} value={st.margin} onChange={(e) => up({ margin: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
              </div>
              {media.kind === "flag" && (
                <label className="flex items-center gap-2">
                  <Checkbox checked={st.flagTurn} onCheckedChange={(v) => up({ flagTurn: !!v })} /> Second half upside down
                </label>
              )}
              <p className="text-2xs text-subtle">
                {media.kind === "heatshrink"
                  ? "Heat-shrink tube: slide over the wire before crimping, shrink with a heat gun."
                  : media.kind === "flag"
                    ? "Flag: wrap the middle around the wire and stick the two halves together — both sides read the same."
                    : media.kind === "wrap"
                      ? "Wrap: the text repeats so it can be read from any side of the wire."
                      : "Straight tape label."}
              </p>
            </fieldset>
          </div>

          {/* preview */}
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs text-muted">
              <span>
                {chosen.length} of {recs.length} label{recs.length === 1 ? "" : "s"} · ≈ {Math.round(totalLen / 10) / 100} m of {media.kind === "heatshrink" ? "tube" : "tape"}
              </span>
              <button className="text-accent hover:underline" onClick={() => setPicked(null)}>
                all
              </button>
              <button className="text-accent hover:underline" onClick={() => setPicked(new Set())}>
                none
              </button>
              <span className="ml-auto">Click labels to choose which to print.</span>
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-md border border-border bg-panel-2 p-2">
              {!recs.length ? (
                <p className="p-6 text-center text-xs text-subtle">No labels — choose other wires, or number the wires first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {recs.slice(0, 400).map((r) => (
                    <LabelPreview key={r.key} r={r} on={!picked || picked.has(r.key)} toggle={() => setPicked((p) => {
                      const s = new Set(p ?? recs.map((x) => x.key));
                      if (s.has(r.key)) s.delete(r.key);
                      else s.add(r.key);
                      return s;
                    })} st={st} layout={layout} />
                  ))}
                  {recs.length > 400 && <p className="w-full text-center text-2xs text-subtle">… {recs.length - 400} more (all are printed / exported)</p>}
                </div>
              )}
            </div>

            {/* printer */}
            <div className="mt-3 rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Printer className="size-4 text-muted" />
                {link ? (
                  <>
                    <span className="font-medium">{link.name}</span>
                    {status ? (
                      status.errors.length ? (
                        <span className="flex items-center gap-1 text-danger">
                          <AlertTriangle className="size-3" /> {status.errors.join(", ")}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-success">
                          <CheckCircle2 className="size-3" /> {status.mediaWidth} mm {MEDIA_TYPE_NAME[status.mediaType] ?? ""}
                        </span>
                      )
                    ) : (
                      <span className="text-subtle">status unknown</span>
                    )}
                    <Button size="xs" variant="ghost" onClick={refresh} disabled={!!busy} aria-label="Refresh printer status">
                      <RefreshCw />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={disconnect} disabled={!!busy}>
                      <Unplug /> Disconnect
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-muted">Brother P-touch:</span>
                    <Button size="xs" variant="secondary" disabled={!usbSupported() || !!busy} onClick={() => connect("usb")} title={usbSupported() ? "PT-E550W, PT-E560BT, PT-P750W, PT-P710BT, PT-P700, PT-D600 … over USB" : "Needs Chrome or Edge on a desktop"}>
                      {busy === "connect" ? <Spinner /> : <Usb />} Connect USB
                    </Button>
                    <Button size="xs" variant="ghost" disabled={!serialSupported() || !!busy} onClick={() => connect("serial")} title="Bluetooth models paired with this computer (PT-P710BT, PT-E560BT …)">
                      <Bluetooth /> Bluetooth / serial
                    </Button>
                    {!usbSupported() && <span className="text-2xs text-subtle">Direct printing needs Chrome or Edge on a desktop — use the PDF otherwise.</span>}
                  </>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs">
                <label className="flex items-center gap-1.5">
                  <Checkbox checked={st.autoCut} onCheckedChange={(v) => up({ autoCut: !!v })} /> Cut after each label
                </label>
                <label className="flex items-center gap-1.5">
                  <Checkbox checked={st.halfCut} onCheckedChange={(v) => up({ halfCut: !!v })} /> Half cut
                </label>
                <label className="flex items-center gap-1.5">
                  Feed
                  <Input type="number" min={0} max={20} step={0.5} value={st.feedMm} onChange={(e) => up({ feedMm: Math.max(0, Number(e.target.value) || 0) })} className="h-6 w-14" /> mm
                </label>
                <details className="text-subtle">
                  <summary className="cursor-pointer">Calibration</summary>
                  <div className="mt-1 flex items-center gap-3">
                    <label className="flex items-center gap-1.5">
                      <Checkbox checked={st.flip} onCheckedChange={(v) => up({ flip: !!v })} /> Upside down
                    </label>
                    <label className="flex items-center gap-1.5">
                      Offset
                      <Input type="number" min={-30} max={30} value={st.offsetPins} onChange={(e) => up({ offsetPins: Number(e.target.value) || 0 })} className="h-6 w-14" /> dots
                    </label>
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="ghost" disabled={!chosen.length || !!busy} onClick={() => run("csv", async () => downloadBlob(new Blob([labelsCsv(chosen, st.content)], { type: "text/csv;charset=utf-8" }), `${base} - wire labels.csv`))} title="Database for P-touch Editor (File → Database → Connect)">
            <Sheet /> CSV
          </Button>
          <Button variant="ghost" disabled={!chosen.length || !!busy} onClick={() => run("sheet", async () => downloadBlob(new Blob([(await sheetPdf(laid(chosen), chosen, media, doc.meta.title || "project")) as BlobPart], { type: "application/pdf" }), `${base} - wire labels (A4).pdf`))} title="All labels at real size on A4 pages, with cut lines">
            {busy === "sheet" ? <Spinner /> : <FileText />} A4 sheet PDF
          </Button>
          <Button variant="secondary" disabled={!chosen.length || !!busy} onClick={() => run("pdf", async () => downloadBlob(new Blob([(await tapePdf(laid(chosen), media, doc.meta.title || "project")) as BlobPart], { type: "application/pdf" }), `${base} - wire labels ${media.width} mm.pdf`))} title="One page per label at the label's size — print with the Brother driver (or any label printer) at 100 %">
            {busy === "pdf" ? <Spinner /> : <FileDown />} Label PDF
          </Button>
          <Button variant="primary" disabled={!link || !chosen.length || !!busy} onClick={() => print(chosen)}>
            {busy === "print" ? <Spinner /> : <Printer />} Print {chosen.length === recs.length ? "all" : chosen.length} label{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LabelPreview({ r, on, toggle, st, layout }: { r: LabelRecord; on: boolean; toggle: () => void; st: Settings; layout: LabelLayout }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const l = layoutLabel(r, st.content, layout, canvasMeasure);
    const c = labelCanvas(l, layout.media, 8, { border: true, cutMarks: true });
    c.style.width = `${c.width / 2}px`;
    c.style.height = `${c.height / 2}px`;
    host.replaceChildren(c);
  }, [r, st.content, layout.media, layout.length, layout.wireDiameter, layout.repeat, layout.margin, layout.flagTurn]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button data-testid="label-preview" onClick={toggle} className={cn("rounded border p-1 text-left transition", on ? "border-accent bg-panel" : "border-transparent opacity-40")} title={`${r.id || "(no number)"} · ${r.end === "both" ? "" : `end ${r.end.toUpperCase()} · `}${r.here} → ${r.there} · sheet ${r.sheet}`}>
      <div ref={ref} />
      <p className="mt-0.5 max-w-48 truncate text-[10px] text-subtle">
        {r.end !== "both" ? `${r.end.toUpperCase()} · ` : ""}
        {r.here}
      </p>
    </button>
  );
}
