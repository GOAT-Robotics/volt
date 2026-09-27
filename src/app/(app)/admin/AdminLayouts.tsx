"use client";
/**
 * Administration → Title block layouts: the organization's title blocks, maintained centrally like
 * style templates (versions, approval, a default for new projects). Projects pick them in the
 * editor; project templates can prescribe one.
 */
import * as React from "react";
import { Plus, PanelBottom, Pencil, Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { Section, useMutation } from "@/components/volt/common";
import { api } from "@/lib/fetcher";
import { fmtDate } from "@/lib/utils";
import { newDoc } from "@/core/doc";
import type { TitleBlockTemplate } from "@/core/model";
import { parseTitleBlockTemplate, titleBlockHeight } from "@/core/qet/titleblock";
import { docStyles, drawTitleBlock, pageGeometry } from "@/core/render/scene";
import { SvgPainter } from "@/core/render/svg";
import { TitleBlockDesigner } from "@/editor/ui/dialogs/TitleBlockEditor";
import { HistoryList, TemplateActions, TemplateList } from "./AdminTemplates";
import type { AdminData } from "./AdminView";

/** preview values for the %variables */
const SAMPLE: Record<string, string> = {
  author: "A. Designer",
  date: "2026-01-31",
  title: "Control circuit",
  filename: "project.qet",
  indexrev: "B",
  version: "3",
  plant: "Plant 1",
  locmach: "Line 2",
  folio: "3/12",
  id: "3",
  total: "12",
  projecttitle: "Project name",
};

const frameWidth = () => {
  const d = newDoc("Preview");
  return pageGeometry(d, d.pages[0]).border.w;
};

/** The layout drawn exactly as on a page (same renderer), as an SVG image */
function previewSvg(t: TitleBlockTemplate, width: number): string {
  const doc = newDoc("Preview");
  const page = doc.pages[0];
  doc.titleBlocks[t.name] = t;
  page.titleBlock = { show: true, template: t.name, fields: { ...SAMPLE } };
  doc.meta.title = SAMPLE.projecttitle;
  const h = titleBlockHeight(t);
  const p = new SvgPainter();
  drawTitleBlock(p, { doc, page, lod: 100, pageIndex: 2, pageCount: 12 }, docStyles(doc), { x: 0, y: 0, w: width, h });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${width + 2} ${h + 2}" width="${width + 2}" height="${h + 2}"><rect x="-1" y="-1" width="${width + 2}" height="${h + 2}" fill="#fff"/>${p.out.join("")}</svg>`;
}

type Layout = AdminData["titleBlockLayouts"][number];

export function TitleBlockLayoutsTab({ data }: { data: AdminData }) {
  const [sel, setSel] = React.useState<string | null>(data.titleBlockLayouts[0]?.id ?? null);
  const [creating, setCreating] = React.useState(false);
  const t = data.titleBlockLayouts.find((x) => x.id === sel) ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Section
        className="self-start"
        title="Title block layouts"
        description="Your organization's title blocks, for every project"
        actions={
          <Button size="xs" variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New
          </Button>
        }
      >
        <div className="p-2">
          {data.titleBlockLayouts.length ? (
            <TemplateList items={data.titleBlockLayouts} selected={sel} onSelect={setSel} icon={<PanelBottom />} />
          ) : (
            <Empty icon={<PanelBottom />} title="No layouts yet">
              Start from a standard title block or your own .titleblock file, add your logo and fields, approve it and make it the default.
            </Empty>
          )}
        </div>
      </Section>
      {t ? <LayoutDetail key={`${t.id}:${t.version}:${t.status}`} t={t} /> : <div />}
      {creating && <CreateLayoutDialog data={data} onClose={() => setCreating(false)} onCreated={setSel} />}
    </div>
  );
}

function LayoutDetail({ t }: { t: Layout }) {
  const [run, busy] = useMutation();
  const [tpl, setTpl] = React.useState<TitleBlockTemplate | null>(null);
  const [xml, setXml] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const width = React.useMemo(frameWidth, []);
  React.useEffect(() => {
    let live = true;
    api<{ xml: string }>(`/api/admin/titleblock-layouts/${t.id}`)
      .then((j) => {
        if (!live) return;
        setXml(j.xml);
        setTpl({ ...parseTitleBlockTemplate(j.xml), name: t.name });
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [t.id, t.name]);
  const svg = React.useMemo(() => (tpl ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSvg(tpl, width))}` : null), [tpl, width]);
  const fields = tpl?.cells.filter((c) => c.type === "field") ?? [];
  const vars = [...new Set(fields.flatMap((c) => [...(c.value ?? "").matchAll(/%\{?([\w-]+)\}?/g)].map((m) => m[1])))];
  const fixed = fields.filter((c) => c.value && !/%\{?[\w-]+\}?/.test(c.value));
  return (
    <div className="min-w-0 space-y-4">
      <Section
        title={
          <span className="flex items-center gap-2">
            {t.name} <StatusBadge status={t.status === "RETIRED" ? "DEPRECATED" : t.status} /> {t.isDefault && <Badge tone="warning">Default for new projects</Badge>}
          </span>
        }
        description={`Version ${t.version} · updated ${fmtDate(t.updatedAt)}${t.status === "DRAFT" ? " · projects keep the last approved version until you approve this one" : ""}`}
        actions={
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="primary" disabled={!tpl} onClick={() => setEditing(true)}>
              <Pencil /> Edit layout
            </Button>
            <Button
              size="xs"
              disabled={!xml}
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([xml!], { type: "application/xml" }));
                a.download = `${t.name.replace(/[^\w.-]+/g, "_")}.titleblock`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              }}
            >
              <Download /> .titleblock
            </Button>
            <TemplateActions kind="titleblock-layouts" t={t} run={run} busy={busy} />
          </div>
        }
      >
        <div className="space-y-3 p-4">
          {error && <p className="text-xs text-danger">{error}</p>}
          {!tpl && !error && <Spinner />}
          {svg && (
            <div className="overflow-x-auto rounded-md border border-border bg-white p-2">
              <img src={svg} alt={`${t.name} preview`} className="h-auto w-full min-w-[640px]" data-testid="layout-preview" />
            </div>
          )}
          {tpl && (
            <div className="grid gap-3 text-2xs text-muted sm:grid-cols-3">
              <p>
                <span className="font-medium text-fg">{tpl.rows.length}</span> rows × <span className="font-medium text-fg">{tpl.cols.length}</span> columns ·{" "}
                <span className="font-medium text-fg">{titleBlockHeight(tpl)} px</span> high
              </p>
              <p>
                Filled per page: {vars.length ? vars.map((v) => <code key={v} className="mr-1 rounded bg-panel-2 px-1">%{v}</code>) : "nothing"}
              </p>
              <p>{fixed.length ? `Fixed text: ${fixed.map((c) => `“${c.value}”`).join(", ")}` : "No fixed text"}</p>
            </div>
          )}
        </div>
      </Section>
      <HistoryList history={t.history} />
      {editing && tpl && (
        <TitleBlockDesigner
          initial={{ ...tpl, xml: xml ?? undefined }}
          width={width}
          vars={SAMPLE}
          editable
          defaultShowVars
          title={`Title block layout · ${t.name}`}
          description="Saving creates a new version (draft). Projects keep the last approved version until you approve it."
          saveLabel="Save version"
          onClose={() => setEditing(false)}
          onSave={async (out) => {
            const ok = await run(() => api(`/api/admin/titleblock-layouts/${t.id}`, { method: "PATCH", json: { name: out.name, xml: out.xml } }), "Saved as new version");
            if (ok) setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function CreateLayoutDialog({ data, onClose, onCreated }: { data: AdminData; onClose: () => void; onCreated: (id: string) => void }) {
  const [run, busy] = useMutation();
  const [name, setName] = React.useState("");
  const [from, setFrom] = React.useState("blank");
  const [fileXml, setFileXml] = React.useState<{ name: string; xml: string } | null>(null);
  const file = React.useRef<HTMLInputElement>(null);
  const readFile = async (f: File) => {
    if (f.size > 6 * 1024 * 1024) return toast.error("Title block files must be under 6 MB");
    const xml = await f.text();
    try {
      const t = parseTitleBlockTemplate(xml);
      setFileXml({ name: f.name, xml });
      if (!name) setName(t.name || f.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      toast.error(`Not a title block template: ${(e as Error).message}`);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New title block layout" description="Start from a standard QElectroTech title block, an existing layout, your own .titleblock file or a blank one — then edit it visually.">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const src = from === "file" ? { xml: fileXml?.xml } : from.startsWith("std:") ? { standard: from.slice(4) } : from.startsWith("copy:") ? { fromId: from.slice(5) } : {};
            const j = await run(() => api<{ id: string }>("/api/admin/titleblock-layouts", { method: "POST", json: { name, ...src } }), "Layout created");
            if (j) {
              onCreated(j.id);
              onClose();
            }
          }}
        >
          <Field label="Name *">
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Example Company A3" />
          </Field>
          <Field label="Start from">
            <NativeSelect value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start from">
              <option value="blank">Blank (Volt's default layout)</option>
              <option value="file">A .titleblock file…</option>
              {data.titleBlockLayouts.length > 0 && (
                <optgroup label="Copy of">
                  {data.titleBlockLayouts.map((l) => (
                    <option key={l.id} value={`copy:${l.id}`}>
                      {l.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Standard">
                {data.standardTitleBlocks.map((n) => (
                  <option key={n} value={`std:${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
            </NativeSelect>
          </Field>
          {from === "file" && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => file.current?.click()}>
                <Upload /> Choose file
              </Button>
              <span className="truncate text-2xs text-muted">{fileXml?.name ?? "QElectroTech .titleblock (XML)"}</span>
              <input
                ref={file}
                type="file"
                accept=".titleblock,.xml,application/xml,text/xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void readFile(f);
                }}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || (from === "file" && !fileXml)}>
              {busy && <Spinner />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
