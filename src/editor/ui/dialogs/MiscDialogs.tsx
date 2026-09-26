"use client";
import { useMemo, useState } from "react";
import { Plus, Trash2, CheckCircle2, AlertTriangle, Archive, XCircle, Download } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Field } from "@/components/ui/input";
import { Switch, Badge, Spinner } from "@/components/ui/misc";
import { exportQet } from "@/core/qet/project";
import type { CompatReport, Page } from "@/core/model";
import { addWire, getPage, pinOrientScene } from "@/core/ops";
import { orthoRoute } from "@/core/wires";
import { toScene } from "@/core/geometry";
import { downloadBlob } from "@/lib/utils";
import { useEffect } from "react";

const LEVEL = {
  supported: { icon: <CheckCircle2 className="size-3.5 text-success" />, label: "Supported" },
  degraded: { icon: <AlertTriangle className="size-3.5 text-warning" />, label: "Degraded" },
  preserved: { icon: <Archive className="size-3.5 text-accent" />, label: "Preserved, not editable" },
  unsupported: { icon: <XCircle className="size-3.5 text-danger" />, label: "Unsupported" },
} as const;

export function ReportView({ report }: { report: Pick<CompatReport, "items"> & Partial<CompatReport> }) {
  const groups = (["unsupported", "degraded", "preserved", "supported"] as const).map((l) => [l, report.items.filter((i) => i.level === l)] as const).filter(([, v]) => v.length);
  return (
    <div className="space-y-3">
      {report.pageCount !== undefined && (
        <div className="grid grid-cols-4 gap-2">
          {[
            ["Pages", report.pageCount],
            ["Components", report.elementCount],
            ["Wires", report.wireCount],
            ["Definitions", report.definitionCount],
          ].map(([k, n]) => (
            <div key={k as string} className="rounded-md border border-border p-2">
              <p className="text-2xs text-subtle">{k}</p>
              <p className="text-sm font-semibold tabular">{n as number}</p>
            </div>
          ))}
        </div>
      )}
      {groups.map(([l, items]) => (
        <div key={l}>
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            {LEVEL[l].icon}
            {LEVEL[l].label}
            <Badge>{items.length}</Badge>
          </h4>
          <ul className="space-y-0.5 pl-5 text-2xs text-muted">
            {items.map((i, k) => (
              <li key={k}>
                <span className="font-medium text-fg">{i.area}</span> — {i.message}
                {i.count ? ` ×${i.count}` : ""}
                {i.page ? ` (${i.page})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CompatDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const v = useEditor((s) => s.version);
  const [tab, setTab] = useState<"export" | "import">("export");
  const [imp, setImp] = useState<CompatReport | null | undefined>(undefined);
  const exp = useMemo(() => {
    try {
      return exportQet(doc).report;
    } catch (e) {
      return { items: [{ level: "unsupported" as const, area: "export", message: (e as Error).message }] } as unknown as CompatReport;
    }
  }, [doc]);
  useEffect(() => {
    if (!v) return;
    fetch(`/api/projects/${v.projectId}/import-report`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setImp(j?.report ?? null))
      .catch(() => setImp(null));
  }, [v]);
  const rep = tab === "export" ? exp : imp;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="QElectroTech compatibility" description={`Baseline: QElectroTech ${doc.qet?.version ?? "0.100"} project format`} wide>
        <div className="mb-3 flex gap-1 text-xs">
          <Button size="xs" variant={tab === "export" ? "secondary" : "ghost"} onClick={() => setTab("export")}>
            If exported now
          </Button>
          <Button size="xs" variant={tab === "import" ? "secondary" : "ghost"} onClick={() => setTab("import")}>
            Original import
          </Button>
        </div>
        {rep === undefined ? <Spinner /> : rep === null ? <p className="text-xs text-subtle">This project was not imported from a .qet file.</p> : <ReportView report={rep} />}
        <DialogFooter>
          {rep && (
            <Button variant="secondary" onClick={() => downloadBlob(new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" }), `compatibility-${tab}.json`)}>
              <Download /> Download report
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PageDialog({ onClose }: { onClose: () => void }) {
  const page = useEditor((s) => s.page());
  const editable = useEditor((s) => !!s.version?.editable);
  const [b, setB] = useState(page.border);
  const [meta, setMeta] = useState(Object.entries(page.meta));
  const [rev, setRev] = useState(page.revMarker ?? "");
  const num = (k: keyof Page["border"]) => (
    <Input type="number" value={b[k] as number} disabled={!editable} onChange={(e) => setB({ ...b, [k]: Math.max(1, Number(e.target.value) || 1) })} />
  );
  const save = () => {
    useEditor.getState().apply("Page settings", (d) => {
      const p = getPage(d, page.id);
      p.border = b;
      p.meta = Object.fromEntries(meta.filter(([k]) => k.trim()));
      p.revMarker = rev || undefined;
    });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Page settings — ${page.title}`} description="Drawing frame (folio) and page metadata. The canvas itself is unlimited; the frame is what prints.">
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 flex items-center justify-between text-xs">
            Show frame <Switch checked={b.show} disabled={!editable} onCheckedChange={(v) => setB({ ...b, show: v })} />
          </label>
          <Field label="Columns">{num("cols")}</Field>
          <Field label="Column width">{num("colW")}</Field>
          <Field label="Rows">{num("rows")}</Field>
          <Field label="Row height">{num("rowH")}</Field>
          <label className="flex items-center justify-between text-xs">
            Column headers <Switch checked={b.showCols} disabled={!editable} onCheckedChange={(v) => setB({ ...b, showCols: v })} />
          </label>
          <label className="flex items-center justify-between text-xs">
            Row headers <Switch checked={b.showRows} disabled={!editable} onCheckedChange={(v) => setB({ ...b, showRows: v })} />
          </label>
          <p className="col-span-2 text-2xs text-subtle tabular">
            Frame: {b.cols * b.colW + (b.showRows ? b.headerW : 0)} × {b.rows * b.rowH + (b.showCols ? b.headerH : 0)} units
          </p>
          <Field label="Page revision marker" className="col-span-2">
            <Input value={rev} disabled={!editable} onChange={(e) => setRev(e.target.value)} placeholder="e.g. B" />
          </Field>
          <div className="col-span-2">
            <p className="mb-1 text-2xs font-medium text-muted">Page metadata</p>
            {meta.map(([k, v], i) => (
              <div key={i} className="mb-1 flex gap-1">
                <Input value={k} disabled={!editable} placeholder="key" onChange={(e) => setMeta(meta.map((m, j) => (j === i ? [e.target.value, m[1]] : m)))} />
                <Input value={v} disabled={!editable} placeholder="value" onChange={(e) => setMeta(meta.map((m, j) => (j === i ? [m[0], e.target.value] : m)))} />
                <Button variant="ghost" size="icon" disabled={!editable} onClick={() => setMeta(meta.filter((_, j) => j !== i))} aria-label="Remove">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button size="xs" variant="secondary" disabled={!editable} onClick={() => setMeta([...meta, ["", ""]])}>
              <Plus /> Add field
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!editable} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectPropsDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const editable = useEditor((s) => !!s.version?.editable);
  const [title, setTitle] = useState(doc.meta.title);
  const [props, setProps] = useState(Object.entries(doc.meta.props));
  const [grid, setGrid] = useState(doc.grid.size);
  const save = () => {
    useEditor.getState().apply("Project properties", (d) => {
      d.meta.title = title;
      d.meta.props = Object.fromEntries(props.filter(([k]) => k.trim()));
      d.grid.size = grid;
    });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Project properties" description="Properties are available in title blocks as %name.">
        <div className="space-y-3">
          <Field label="Title">
            <Input value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Grid step">
            <NativeSelect value={grid} disabled={!editable} onChange={(e) => setGrid(Number(e.target.value))}>
              {[5, 10, 20].map((g) => (
                <option key={g} value={g}>
                  {g} units
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div>
            <p className="mb-1 text-2xs font-medium text-muted">Custom properties</p>
            {props.map(([k, v], i) => (
              <div key={i} className="mb-1 flex gap-1">
                <Input value={k} disabled={!editable} placeholder="name" onChange={(e) => setProps(props.map((m, j) => (j === i ? [e.target.value.replace(/\s/g, "_"), m[1]] : m)))} />
                <Input value={v} disabled={!editable} placeholder="value" onChange={(e) => setProps(props.map((m, j) => (j === i ? [m[0], e.target.value] : m)))} />
                <Button variant="ghost" size="icon" disabled={!editable} onClick={() => setProps(props.filter((_, j) => j !== i))} aria-label="Remove">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button size="xs" variant="secondary" disabled={!editable} onClick={() => setProps([...props, ["", ""]])}>
              <Plus /> Add property
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!editable} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Keyboard-accessible alternative to drawing a wire. */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const page = useEditor((s) => s.page());
  const doc = useEditor((s) => s.doc);
  const sel = useEditor((s) => s.sel);
  const ui = useEditorUI();
  const els = useMemo(() => page.elements.filter((e) => doc.defs[e.defId]?.pins.length).sort((a, b) => (a.info.label ?? "").localeCompare(b.info.label ?? "")), [page, doc]);
  const [a, setA] = useState(sel.elements[0] ?? els[0]?.id ?? "");
  const [b, setB] = useState(sel.elements[1] ?? els[1]?.id ?? "");
  const pinsOf = (id: string) => {
    const e = page.elements.find((x) => x.id === id);
    return e ? doc.defs[e.defId]?.pins ?? [] : [];
  };
  const [pa, setPa] = useState(pinsOf(a)[0]?.id ?? "");
  const [pb, setPb] = useState(pinsOf(b)[0]?.id ?? "");
  const label = (id: string) => {
    const e = page.elements.find((x) => x.id === id);
    return e ? `${e.info.label || "—"} (${doc.defs[e.defId]?.name})` : "";
  };
  const connect = () => {
    const ea = page.elements.find((x) => x.id === a), eb = page.elements.find((x) => x.id === b);
    const da = ea && doc.defs[ea.defId], db = eb && doc.defs[eb.defId];
    const pinA = da?.pins.find((p) => p.id === pa), pinB = db?.pins.find((p) => p.id === pb);
    if (!ea || !eb || !da || !db || !pinA || !pinB) return;
    const p1 = toScene(ea, pinA), p2 = toScene(eb, pinB);
    const pts = orthoRoute(p1, p2, pinOrientScene(ea, da, pa), pinOrientScene(eb, db, pb));
    useEditor.getState().apply("Connect pins", (d) => addWire(getPage(d, page.id), { k: "pin", el: a, pin: pa, p: p1 }, { k: "pin", el: b, pin: pb, p: p2 }, pts));
    ui.announce(`Connected ${ea.info.label}:${pinA.number || pinA.name} to ${eb.info.label}:${pinB.number || pinB.name}`);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Connect pins" description="Creates an automatically routed wire between two pins.">
        <div className="grid grid-cols-2 gap-3">
          {[
            ["From", a, setA, pa, setPa],
            ["To", b, setB, pb, setPb],
          ].map(([l, el, setEl, pin, setPin]) => (
            <div key={l as string} className="space-y-1.5">
              <Field label={`${l} component`}>
                <NativeSelect
                  value={el as string}
                  onChange={(e) => {
                    (setEl as (v: string) => void)(e.target.value);
                    (setPin as (v: string) => void)(pinsOf(e.target.value)[0]?.id ?? "");
                  }}
                >
                  {els.map((e) => (
                    <option key={e.id} value={e.id}>
                      {label(e.id)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Pin">
                <NativeSelect value={pin as string} onChange={(e) => (setPin as (v: string) => void)(e.target.value)}>
                  {pinsOf(el as string).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number || "—"} {p.name && `· ${p.name}`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!a || !b || !pa || !pb || (a === b && pa === pb)} onClick={connect}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
