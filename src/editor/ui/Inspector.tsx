"use client";
import { useEffect, useMemo, useState } from "react";
import { RotateCw, RotateCcw, FlipHorizontal2, Lock, Unlock, RotateCcw as Reset, Plus, X, Link2, Unlink, ExternalLink, Pencil, Eye, EyeOff, AlignLeft, AlignCenter, AlignRight, Printer } from "lucide-react";
import { toast } from "sonner";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { runCommand } from "./commands";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge, Switch, Tip } from "@/components/ui/misc";
import { getPage, emptySel, scaleElements } from "@/core/ops";
import type { Doc, ElemInst, LineStyle, Page, PlacedText, Shape, TextRole, TextStyle, TitleBlockTemplate, Wire, WireEnd } from "@/core/model";
import { TEXT_ROLES, COMPONENT_INFO, type ComponentInfoFlags, type ComponentInfoKey, type InfoLayout, type InfoPlacement } from "@/core/model";
import { ConductorSection, Swatch } from "./Conductor";
import { PartDocuments } from "@/components/volt/PartDocuments";
import { StylePicker } from "./StylePicker";
import { TitleBlockLogos } from "./TitleBlockLogos";
import { FreeTextInspector } from "./FreeTextInspector";
import { MatingSection } from "./MatingSection";
import { CoverSection, PageTypeRow } from "./CoverInspector";
import { logoBytes, logoDataUrl, logoSize } from "@/core/logos";
import { PICTURE_LIMITS, readLogoFile } from "./logoUpload";
import { endAddress, wireEndLabel, wireInfo, wiringOf } from "@/core/wiring";
import { ROLE_LABELS } from "@/core/styles";
import { DEFAULT_FRAME, docStyles, tbTemplate, wireTextAnchor } from "@/core/render/scene";
import { templateVariables } from "@/core/titleblock-edit";
import { symbolThumb } from "../thumb";
import { pinDegree } from "../engine/snap";
import { polylineLength } from "@/core/geometry";
import { cachedXref, describe } from "@/core/xref";
import { measureText } from "@/core/render/canvas";
import { cn } from "@/lib/utils";
import { isBomExcluded } from "@/core/bom";
import { collectStrips, isTerminalDef, parseTerminalRef, terminalTypeLabel } from "@/core/terminals";

/* small building blocks */
export function Section({ title, children, actions, defaultOpen = true }: { title: string; children: React.ReactNode; actions?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <div className="flex h-8 items-center justify-between px-3">
        <button className="text-2xs font-semibold uppercase tracking-wide text-subtle hover:text-muted" onClick={() => setOpen(!open)} aria-expanded={open}>
          {title}
        </button>
        {actions}
      </div>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}
export function Row({ label, children, hint }: { label: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2">
      <span className="truncate text-2xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
      {hint && <p className="col-span-2 text-2xs text-subtle">{hint}</p>}
    </div>
  );
}

/** Input that commits on blur/enter (one undo step per edit). */
export function Commit({ value, onCommit, type = "text", disabled, placeholder, className, ...rest }: { value: string | number; onCommit: (v: string) => void; type?: string; disabled?: boolean; placeholder?: string; className?: string; step?: number; min?: number; max?: number; list?: string; "aria-label"?: string }) {
  const [v, setV] = useState(String(value ?? ""));
  useEffect(() => setV(String(value ?? "")), [value]);
  return (
    <Input
      type={type}
      value={v}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== String(value ?? "") && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(String(value ?? ""));
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      {...rest}
    />
  );
}

export function ColorInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-6 w-7 cursor-pointer rounded border border-border bg-panel p-0.5" aria-label="Color" />
      <Commit value={value} onCommit={onChange} disabled={disabled} className="font-mono" />
    </div>
  );
}

export const Overridden = ({ on, onReset }: { on: boolean; onReset: () => void }) =>
  on ? (
    <Tip content="Overrides the project style — click to reset">
      <button onClick={onReset} className="ml-1 inline-flex items-center gap-0.5 rounded bg-warning-soft px-1 text-[9px] font-medium text-warning" aria-label="Reset override">
        override <Reset className="size-2" />
      </button>
    </Tip>
  ) : null;

export function Inspector() {
  const sel = useEditor((s) => s.sel);
  const page = useEditor((s) => s.page());
  const doc = useEditor((s) => s.doc);
  const editable = useEditor((s) => !!s.version?.editable);
  const shapes = sel.shapes ?? [];
  const n = sel.elements.length + sel.wires.length + sel.junctions.length + sel.texts.length + shapes.length;
  if (n === 0) return <PageInspector page={page} doc={doc} editable={editable} />;
  if (shapes.length === n) return <ShapeInspector ids={shapes} page={page} editable={editable} />;
  if (sel.elements.length === 1 && n === 1) {
    const e = page.elements.find((x) => x.id === sel.elements[0]);
    if (e) return <ElementInspector e={e} page={page} doc={doc} editable={editable} />;
  }
  if (sel.wires.length === 1 && n === 1) {
    const w = page.wires.find((x) => x.id === sel.wires[0]);
    if (w) return <WireInspector w={w} page={page} doc={doc} editable={editable} />;
  }
  if (sel.texts.length === 1 && n === 1) {
    const t = page.texts.find((x) => x.id === sel.texts[0]);
    if (t) return <FreeTextInspector id={t.id} page={page} doc={doc} editable={editable} />;
  }
  return <MultiInspector />;
}

/* ------------------------------------------------------------------ */

type TbCatalog = { std: string[]; org: { id: string; name: string; version: number; isDefault: boolean }[] };
let tbCache: Promise<TbCatalog> | null = null;
/** title blocks the editor offers: organization layouts (Administration) and the standard set */
function useTitleBlockCatalog() {
  const [cat, setCat] = useState<TbCatalog>({ std: [], org: [] });
  useEffect(() => {
    tbCache ??= fetch("/api/titleblocks")
      .then((r) => (r.ok ? r.json() : { templates: [], organization: [] }))
      .then((j: { templates: { name: string }[]; organization?: TbCatalog["org"] }) => ({ std: j.templates.map((t) => t.name), org: j.organization ?? [] }))
      .catch(() => ({ std: [], org: [] }));
    let live = true;
    void tbCache.then((c) => live && setCat(c));
    return () => {
      live = false;
    };
  }, []);
  return cat;
}

/** friendlier names for QElectroTech's title block variables */
const TB_FIELD_LABEL: Record<string, string> = {
  title: "Sheet title",
  author: "Author",
  date: "Date",
  filename: "File name",
  indexrev: "Revision",
  version: "Version",
  plant: "Plant",
  locmach: "Location",
  folio: "Sheet no.",
};

async function renameProject(name: string) {
  const st = useEditor.getState();
  const v = st.version;
  const next = name.trim();
  if (!next) return;
  if (v) {
    const r = await fetch(`/api/projects/${v.projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return void toast.error(j.error ?? "Could not rename the project");
    }
    useEditor.setState((x) => ({ version: x.version ? { ...x.version, projectName: next } : x.version }));
  }
  // the drawing's project title (%projecttitle in title blocks) follows the project name
  if (useEditor.getState().doc?.meta.title !== next) useEditor.getState().apply("Rename project", (d) => {
      d.meta.title = next;
    });
  toast.success("Project renamed");
}

function PageInspector({ page, doc, editable }: { page: Page; doc: Doc; editable: boolean }) {
  const projectName = useEditor((x) => x.version?.projectName);
  const ui = useEditorUI();
  const s = useEditor.getState;
  const upd = (label: string, fn: (p: Page) => void) =>
    s().apply(label, (d) => {
      fn(getPage(d, page.id));
    });
  const tpl = doc.titleBlocks[page.titleBlock.template];
  const { std, org } = useTitleBlockCatalog();
  const usedVars = useMemo(() => templateVariables(tpl ?? tbTemplate(doc, page)), [tpl, doc, page]);
  const fieldNames = useMemo(() => {
    const names = new Set<string>(["title", "author", "date", "filename", "indexrev", "version", "plant", "locmach"]);
    for (const c of tpl?.cells ?? []) if (c.type === "field") for (const m of (c.value ?? "").matchAll(/%\{?(\w+)\}?/g)) names.add(m[1]);
    for (const k of Object.keys(page.titleBlock.fields)) names.add(k.replace(/^custom:/, ""));
    for (const k of ["id", "total", "folio", "autonum", "projecttitle"]) names.delete(k);
    return [...names];
  }, [tpl, page.titleBlock.fields]);
  return (
    <div>
      <Section title="Page">
        <Row label="Page name">
          <Commit value={page.title} disabled={!editable} aria-label="Page name" onCommit={(v) => upd("Rename page", (p) => (p.title = v || p.title))} />
        </Row>
        <PageTypeRow page={page} editable={editable} />
        <Row label="Elements">
          <span className="text-xs tabular">
            {page.elements.length} components · {page.wires.length} wires
          </span>
        </Row>
        <Button size="xs" variant="secondary" onClick={() => runCommand("pageSettings", ui)}>
          Border & sheet settings…
        </Button>
      </Section>
      {page.kind === "cover" && <CoverSection page={page} doc={doc} editable={editable} />}
      <Section title="Title block">
        <Row label="Show">
          <Switch checked={page.titleBlock.show} disabled={!editable} onCheckedChange={(v) => upd("Toggle title block", (p) => (p.titleBlock.show = v))} />
        </Row>
        <Row label="Template">
          <NativeSelect
            value={page.titleBlock.template}
            disabled={!editable}
            onChange={async (e) => {
              const v = e.target.value;
              if (!v.startsWith("std:") && !v.startsWith("org:")) return upd("Title block template", (p) => (p.titleBlock.template = v));
              const name = v.slice(4);
              const r = await fetch(`/api/titleblocks/${encodeURIComponent(name)}${v.startsWith("org:") ? "?source=org" : ""}`);
              if (!r.ok) return void toast.error("Could not load title block");
              const { template } = (await r.json()) as { template: TitleBlockTemplate };
              s().apply("Title block template", (d) => {
                d.titleBlocks[template.name] = template;
                getPage(d, page.id).titleBlock.template = template.name;
              });
            }}
            aria-label="Title block template"
          >
            <optgroup label="In this project">
              {Object.keys(doc.titleBlocks).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </optgroup>
            {org.filter((l) => !doc.titleBlocks[l.name]).length > 0 && (
              <optgroup label="Organization">
                {org
                  .filter((l) => !doc.titleBlocks[l.name])
                  .map((l) => (
                    <option key={l.id} value={`org:${l.id}`}>
                      {l.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {std.filter((k) => !doc.titleBlocks[k]).length > 0 && (
              <optgroup label="Standard">
                {std
                  .filter((k) => !doc.titleBlocks[k])
                  .map((k) => (
                    <option key={k} value={`std:${k}`}>
                      {k}
                    </option>
                  ))}
              </optgroup>
            )}
          </NativeSelect>
        </Row>
        {doc.pages.some((p) => p.titleBlock.template !== page.titleBlock.template) && editable && (
          <button
            className="text-2xs text-accent hover:underline"
            onClick={() =>
              s().apply("Title block template for all pages", (d) => {
                for (const p of d.pages) p.titleBlock.template = page.titleBlock.template;
              })
            }
          >
            Use this template on all {doc.pages.length} pages
          </button>
        )}
        {tpl?.layout && (() => {
          const cur = org.find((l) => l.id === tpl.layout!.id);
          return cur && cur.version > tpl.layout!.version && editable ? (
            <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-2 py-1.5 text-2xs">
              <span className="flex-1">Version {cur.version} of this organization layout is approved.</span>
              <button
                className="font-medium text-accent hover:underline"
                onClick={async () => {
                  const r = await fetch(`/api/titleblocks/${encodeURIComponent(cur.id)}?source=org`);
                  if (!r.ok) return void toast.error("Could not load the layout");
                  const { template } = (await r.json()) as { template: TitleBlockTemplate };
                  const oldName = page.titleBlock.template;
                  s().apply("Update title block layout", (d) => {
                    delete d.titleBlocks[oldName];
                    d.titleBlocks[template.name] = template;
                    for (const p of d.pages) if (p.titleBlock.template === oldName) p.titleBlock.template = template.name;
                  });
                  toast.success(`Title block updated to version ${cur.version}`);
                }}
              >
                Update
              </button>
            </div>
          ) : null;
        })()}
        <Button size="xs" variant="secondary" onClick={() => ui.openDialog("titleBlock", { template: page.titleBlock.template })}>
          <Pencil /> Edit template layout…
        </Button>
        <TitleBlockLogos doc={doc} templateName={page.titleBlock.template} editable={editable} />
        {fieldNames.map((f) => (
          <Row
            key={f}
            label={TB_FIELD_LABEL[f] ?? f}
            hint={
              !usedVars.has(f) ? (
                <span>
                  Not shown by this template.{" "}
                  <button className="text-accent hover:underline" onClick={() => ui.openDialog("titleBlock", { template: page.titleBlock.template })}>
                    Edit template
                  </button>
                </span>
              ) : f === "title" ? (
                "Empty uses the page name"
              ) : undefined
            }
          >
            <Commit
              value={page.titleBlock.fields[f] ?? page.titleBlock.fields["custom:" + f] ?? ""}
              placeholder={f === "title" ? page.title : undefined}
              aria-label={TB_FIELD_LABEL[f] ?? f}
              disabled={!editable}
              onCommit={(v) =>
                upd(`Title block ${f}`, (p) => {
                  const key = p.titleBlock.fields["custom:" + f] !== undefined ? "custom:" + f : f;
                  p.titleBlock.fields[key] = v;
                })
              }
            />
          </Row>
        ))}
        <p className="text-2xs text-subtle">Fields support variables like %title, %folio, %id/%total, %projecttitle and project properties.</p>
      </Section>
      <Section title="Project">
        <Row label="Project name" hint="Renames the project everywhere; shown in title blocks as %projecttitle">
          <Commit value={projectName ?? doc.meta.title} disabled={!editable} aria-label="Project name" onCommit={(v) => void renameProject(v)} />
        </Row>
        <Row label="Drawing style">
          <StylePicker />
        </Row>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" onClick={() => runCommand("styles", ui)}>
            Global styles…
          </Button>
          <Button size="xs" onClick={() => runCommand("numbering", ui)}>
            Numbering…
          </Button>
          <Button size="xs" onClick={() => runCommand("wiring", ui)}>
            Wiring & cables…
          </Button>
          <Button size="xs" onClick={() => runCommand("projectProps", ui)}>
            Properties…
          </Button>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const COMMON_INFO = ["label", "comment", "function", "location", "manufacturer", "manufacturer_reference", "supplier", "quantity", "unity", "description", "designation", "machine_manufacturer_reference", "auxiliary1"];
const INFO_LABEL: Record<string, string> = {
  label: "Reference",
  description: "Name",
  rating: "Rating",
  manufacturer_reference: "Part number",
  manufacturer: "Manufacturer",
  comment: "Comment",
  function: "Function",
  location: "Location",
  supplier: "Supplier",
  quantity: "Quantity",
  unity: "Unit",
  designation: "Designation",
  machine_manufacturer_reference: "Machine ref.",
  auxiliary1: "Auxiliary",
};

/** edited in Component info → Bill of materials, not in the generic field list */
const BOM_KEYS = ["bom", "quantity", "unity", "supplier"];

function ElementInspector({ e, page, doc, editable }: { e: ElemInst; page: Page; doc: Doc; editable: boolean }) {
  const def = doc.defs[e.defId];
  const v = useEditor((st) => st.version);
  const ui = useEditorUI();
  const styles = docStyles(doc);
  const s = useEditor.getState;
  const upd = (label: string, fn: (x: ElemInst) => void) =>
    s().apply(label, (d) => {
      const x = getPage(d, page.id).elements.find((y) => y.id === e.id);
      if (x) fn(x);
    });
  const deg = useMemo(() => pinDegree(page), [page]);
  const resize = (f: (k: number) => number) => s().apply("Resize", (d) => scaleElements(d, getPage(d, page.id), [e.id], f));
  const [showAll, setShowAll] = useState(false);
  const [newKey, setNewKey] = useState("");
  if (!def) return <p className="p-3 text-xs text-danger">Definition missing.</p>;
  const infoKeys = [...new Set(["label", "comment", "function", "location", ...Object.keys(def.info), ...Object.keys(e.info)])];
  const visibleKeys = (showAll ? [...new Set([...infoKeys, ...COMMON_INFO])] : infoKeys).filter((k) => !COMPONENT_INFO.some((c) => c.key === k) && !BOM_KEYS.includes(k));
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border p-3">
        <img src={symbolThumb(def, 56)} alt="" className="size-12 rounded border border-border bg-white" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{e.info.label || <span className="text-subtle">No reference</span>}</p>
          <p className="truncate text-2xs text-muted">{def.names.en ?? def.name}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {def.placeholder && <Badge tone="warning">definition missing</Badge>}
            {def.source?.libraryElementId && <Badge tone={def.source.status === "APPROVED" ? "success" : "neutral"}>lib rev {def.source.revision}</Badge>}
            {e.locked && <Badge tone="accent">locked</Badge>}
            {e.group && <Badge tone="purple">block: {e.group.name} ({e.group.mode})</Badge>}
          </div>
        </div>
      </div>
      <XrefSection id={e.id} />
      <MatingSection e={e} page={page} doc={doc} editable={editable} />
      {isTerminalDef(def) && <TerminalSection e={e} doc={doc} />}
      {e.group && <BlockSection e={e} page={page} editable={editable} />}
      <Section title="Identity">
        <Row label="Reference">
          <div className="flex items-center gap-1">
            <Commit
              value={e.info.label ?? ""}
              disabled={!editable}
              onCommit={(v) => {
                const old = (e.info.label ?? "").trim();
                // the device's other parts (contacts, other representations) carry the same reference: rename them too
                const others = old ? doc.pages.flatMap((p) => p.elements.filter((x) => x.id !== e.id && (x.info.label ?? "").trim() === old && !doc.defs[x.defId]?.linkType?.endsWith("_report"))) : [];
                const clash = v.trim() && v.trim() !== old && doc.pages.some((p) => p.elements.some((x) => (x.info.label ?? "").trim() === v.trim() && x.id !== e.id && !others.includes(x)));
                const ids = new Set(others.map((x) => x.id));
                s().apply("Edit reference", (d) => {
                  for (const p of d.pages)
                    for (const x of p.elements) {
                      if (x.id === e.id) ((x.info.label = v), (x.refLocked = true));
                      else if (ids.has(x.id)) x.info.label = v;
                    }
                });
                if (others.length) ui.toast(`Also renamed ${others.length} other part${others.length === 1 ? "" : "s"} of ${old} (contacts / other sheets)`, { undo: true });
                if (clash) ui.toast(`${v.trim()} is already used by another component`, { tone: "error" });
              }}
            />
            <Tip content={e.refLocked ? "Reference locked — renumbering keeps it" : "Reference follows automatic numbering"}>
              <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => upd("Toggle reference lock", (x) => (x.refLocked = !x.refLocked))} aria-label="Toggle reference lock">
                {e.refLocked ? <Lock /> : <Unlock />}
              </Button>
            </Tip>
          </div>
        </Row>
        {e.texts.some((t) => t.info === "label") && (
          <Row label="Text direction">
            <div className="flex rounded-md border border-border p-0.5 text-2xs" role="radiogroup" aria-label="Reference text direction">
              {([
                [undefined, "With component"],
                [0, "Horizontal"],
                [90, "Vertical"],
              ] as const).map(([v, l]) => {
                const cur = e.texts.find((t) => t.info === "label")?.rotation;
                return (
                  <button
                    key={l}
                    role="radio"
                    aria-checked={cur === v}
                    disabled={!editable}
                    title={v === undefined ? "Turns with the component" : "Stays like this when the component is rotated (⌥R cycles)"}
                    className={cn("flex-1 rounded px-1.5 py-0.5", cur === v ? "bg-hover font-medium text-fg" : "text-subtle")}
                    onClick={() =>
                      upd("Reference text direction", (x) => {
                        const t = x.texts.find((y) => y.info === "label");
                        if (!t) return;
                        if (v === undefined) delete t.rotation;
                        else t.rotation = v;
                      })
                    }
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          </Row>
        )}
        {visibleKeys
          .filter((k) => k !== "label")
          .map((k) => (
            <Row key={k} label={INFO_LABEL[k] ?? k}>
              <Commit value={e.info[k] ?? ""} placeholder={def.info[k] ?? ""} disabled={!editable} onCommit={(v) => upd(`Edit ${k}`, (x) => (v ? (x.info[k] = v) : delete x.info[k]))} />
            </Row>
          ))}
        <div className="flex items-center gap-1">
          <button className="text-2xs text-accent hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Fewer fields" : "More fields"}
          </button>
          {editable && (
            <div className="ml-auto flex items-center gap-1">
              <Input value={newKey} onChange={(ev) => setNewKey(ev.target.value.replace(/\s+/g, "_"))} placeholder="custom property" className="h-6 w-28 text-2xs" onKeyDown={(ev) => ev.stopPropagation()} />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Add property"
                disabled={!newKey}
                onClick={() => {
                  upd("Add property", (x) => (x.info[newKey] = x.info[newKey] ?? ""));
                  setShowAll(true);
                  setNewKey("");
                }}
              >
                <Plus />
              </Button>
            </div>
          )}
        </div>
      </Section>
      <ComponentInfoSection e={e} doc={doc} editable={editable} upd={upd} />
      {v && (
        <Section title="Documents" defaultOpen={false}>
          <PartDocuments
            compact
            target={{ scope: "COMPONENT", projectId: v.projectId, elementId: e.id, libraryElementId: def.source?.libraryElementId ?? null }}
            partNumber={e.info.manufacturer_reference || def.info.manufacturer_reference || undefined}
            manufacturer={e.info.manufacturer || def.info.manufacturer || undefined}
            onError={(m) => ui.toast(m, { tone: "error" })}
          />
        </Section>
      )}
      <Section title="Placement">
        <Row label="Position">
          <div className="grid grid-cols-2 gap-1">
            <Commit type="number" value={e.x} disabled={!editable || e.locked} aria-label="X" onCommit={(v) => runMove(page.id, e, Number(v) - e.x, 0)} />
            <Commit type="number" value={e.y} disabled={!editable || e.locked} aria-label="Y" onCommit={(v) => runMove(page.id, e, 0, Number(v) - e.y)} />
          </div>
        </Row>
        <Row label="Orientation">
          <div className="flex items-center gap-1">
            <span className="w-8 text-xs tabular">{e.rot * 90}°</span>
            <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => runCommand("rotateCcw", ui)} aria-label="Rotate counter-clockwise">
              <RotateCcw />
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => runCommand("rotate", ui)} aria-label="Rotate clockwise">
              <RotateCw />
            </Button>
            <Button variant="tool" size="icon-sm" active={e.mirror} disabled={!editable} onClick={() => runCommand("mirror", ui)} aria-label="Mirror">
              <FlipHorizontal2 />
            </Button>
          </div>
        </Row>
        <Row label="Size" hint={e.scale && e.scale !== 1 ? "Pins move with the size: wires stay attached; off-grid pins are possible" : undefined}>
          <div className="flex items-center gap-1">
            <NativeSelect
              value={[0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(e.scale ?? 1) ? String(e.scale ?? 1) : "custom"}
              disabled={!editable || e.locked}
              aria-label="Component size"
              onChange={(ev) => ev.target.value !== "custom" && resize(() => Number(ev.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((k) => (
                <option key={k} value={k}>
                  {Math.round(k * 100)} %
                </option>
              ))}
              {![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(e.scale ?? 1) && <option value="custom">{Math.round((e.scale ?? 1) * 100)} %</option>}
            </NativeSelect>
            <Commit type="number" min={20} max={500} step={5} value={Math.round((e.scale ?? 1) * 100)} disabled={!editable || e.locked} aria-label="Size percent" onCommit={(v) => resize(() => Number(v) / 100 || 1)} className="w-16" />
          </div>
        </Row>
        <Row label="Locked">
          <Switch checked={!!e.locked} disabled={!editable} onCheckedChange={(v) => upd("Lock", (x) => (x.locked = v))} />
        </Row>
      </Section>
      <Section title={`Pins (${def.pins.length})`} actions={<PinToggles e={e} editable={editable} styles={styles} upd={upd} />}>
        {def.pins.length ? (
          <div className="max-h-56 overflow-auto rounded-md border border-border">
            <table className="w-full text-2xs">
              <thead className="sticky top-0 bg-panel-2 text-subtle">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">No.</th>
                  <th className="px-2 py-1 text-left font-medium">Name</th>
                  <th className="px-2 py-1 text-right font-medium">Wires</th>
                </tr>
              </thead>
              <tbody>
                {def.pins.map((p) => {
                  const n = deg.get(e.id + "/" + p.id) ?? 0;
                  return (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-2 py-1 font-mono">{p.number || "—"}</td>
                      <td className="px-2 py-1">{p.name || <span className="text-subtle">—</span>}</td>
                      <td className="px-2 py-1 text-right">
                        {n ? <span className="inline-flex items-center gap-0.5 text-success"><Link2 className="size-2.5" />{n}</span> : <span className={cn("inline-flex items-center gap-0.5", p.required ? "text-warning" : "text-subtle")}><Unlink className="size-2.5" />0</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-2xs text-subtle">This element has no connection points.</p>
        )}
      </Section>
      <Section title="Texts & style">
        {e.texts.map((t) => (
          <TextStyleRow key={t.id} t={t} e={e} editable={editable} styles={styles} upd={upd} />
        ))}
        <Row label="Symbol color">
          <div className="flex items-center gap-1">
            <ColorInput value={e.outlineOverride?.color ?? styles.graphics.outline.color ?? "#000000"} disabled={!editable} onChange={(v) => upd("Symbol color", (x) => (x.outlineOverride = { ...(x.outlineOverride ?? {}), color: v }))} />
            <Overridden on={!!e.outlineOverride} onReset={() => upd("Reset symbol color", (x) => (x.outlineOverride = undefined))} />
          </div>
        </Row>
        <FrameRow e={e} styles={styles} editable={editable} upd={upd} />
      </Section>
      <Section title="Definition" defaultOpen={false}>
        <Row label="Type">
          <span className="text-xs">{def.linkType}</span>
        </Row>
        <Row label="Prefix">
          <span className="font-mono text-xs">{def.prefix || "—"}</span>
        </Row>
        <Row label="Category">
          <span className="truncate text-xs">{def.category || "—"}</span>
        </Row>
        {Object.entries(def.meta)
          .filter(([, v]) => v)
          .slice(0, 8)
          .map(([k, v]) => (
            <Row key={k} label={k}>
              <span className="truncate text-xs">{v}</span>
            </Row>
          ))}
        <div className="flex flex-wrap gap-1.5">
          {def.source?.libraryElementId && (
            <Button size="xs" variant="secondary" onClick={() => window.open(`/library/${def.source!.libraryElementId}`, "_blank")}>
              <ExternalLink /> Open in library
            </Button>
          )}
          <Button size="xs" variant="secondary" onClick={() => ui.openDialog("createElement", { fromDef: def.id })}>
            <Pencil /> Save as library element…
          </Button>
        </div>
      </Section>
    </div>
  );
}

function ComponentInfoSection({ e, doc, editable, upd }: { e: ElemInst; doc: Doc; editable: boolean; upd: (l: string, f: (x: ElemInst) => void) => void }) {
  const def = doc.defs[e.defId];
  const styles = docStyles(doc);
  const defaults = styles.graphics.componentInfo ?? {};
  const shown = (k: ComponentInfoKey) => e.showInfo?.[k] ?? defaults[k] ?? false;
  const s = useEditor.getState;
  const layoutDefault = styles.graphics.componentInfoLayout ?? {};
  const at = e.infoLayout?.at ?? layoutDefault.at ?? "auto";
  const align = e.infoLayout?.align ?? layoutDefault.align;
  const makeDefault = () =>
    s().apply("Component info display", (d) => {
      const flags = Object.fromEntries(COMPONENT_INFO.map((c) => [c.key, shown(c.key)])) as ComponentInfoFlags;
      const lay: InfoLayout = { at: at === "free" ? "auto" : at, ...(align ? { align } : {}) };
      d.styles = { ...d.styles, graphics: { ...(d.styles.graphics ?? {}), componentInfo: flags, componentInfoLayout: lay } };
      for (const p of d.pages)
        for (const x of p.elements) {
          delete x.showInfo;
          delete x.infoLayout;
        }
    });
  const custom =
    (!!e.showInfo && COMPONENT_INFO.some((c) => e.showInfo![c.key] !== undefined && e.showInfo![c.key] !== (defaults[c.key] ?? false))) ||
    (!!e.infoLayout && ((e.infoLayout.at !== undefined && e.infoLayout.at !== (layoutDefault.at ?? "auto")) || (e.infoLayout.align !== undefined && e.infoLayout.align !== layoutDefault.align)));
  const inBom = !isBomExcluded(e);
  const setLayout = (label: string, p: InfoLayout) => upd(label, (x) => (x.infoLayout = { ...(x.infoLayout ?? {}), ...p, ...(p.at && p.at !== "free" ? { pos: undefined } : {}) }));
  return (
    <Section
      title="Component info"
      actions={
        editable && custom ? (
          <button className="text-2xs text-accent hover:underline" onClick={makeDefault} title="Show these lines on every component of the project">
            Use for all
          </button>
        ) : undefined
      }
    >
      {COMPONENT_INFO.map((c) => {
        const on = shown(c.key);
        return (
          <Row key={c.key} label={c.name}>
            <div className="flex items-center gap-1">
              <Commit
                value={e.info[c.key] ?? ""}
                placeholder={def?.info[c.key] ?? (c.key === "rating" ? "e.g. 16 A, 400 V" : c.key === "description" ? "e.g. 2-pole MCB" : "")}
                disabled={!editable}
                onCommit={(v) => upd(`Edit ${c.name.toLowerCase()}`, (x) => (v ? (x.info[c.key] = v) : delete x.info[c.key]))}
                aria-label={c.name}
              />
              <Tip content={on ? `Hide ${c.name.toLowerCase()} on the drawing` : `Show ${c.name.toLowerCase()} on the drawing`}>
                <Button variant="ghost" size="icon-sm" disabled={!editable} aria-pressed={on} aria-label={`${on ? "Hide" : "Show"} ${c.name.toLowerCase()}`} onClick={() => upd(on ? `Hide ${c.name.toLowerCase()}` : `Show ${c.name.toLowerCase()}`, (x) => (x.showInfo = { ...(x.showInfo ?? {}), [c.key]: !on }))}>
                  {on ? <Eye /> : <EyeOff className="text-subtle" />}
                </Button>
              </Tip>
            </div>
          </Row>
        );
      })}
      <Row label="In BOM" hint={inBom ? undefined : "Left out of the bill of materials"}>
        <div className="flex items-center gap-2">
          <Switch
            checked={inBom}
            disabled={!editable}
            aria-label="Include in bill of materials"
            onCheckedChange={(on) => upd(on ? "Include in BOM" : "Leave out of BOM", (x) => (on ? delete x.info.bom : (x.info.bom = "no")))}
          />
          <Commit
            value={e.info.quantity ?? ""}
            placeholder={def?.info.quantity ?? "Qty 1"}
            disabled={!editable || !inBom}
            aria-label="Quantity"
            className="w-16"
            onCommit={(v) => upd("Edit quantity", (x) => (v.trim() ? (x.info.quantity = v.trim()) : delete x.info.quantity))}
          />
          <Commit
            value={e.info.unity ?? ""}
            placeholder={def?.info.unity ?? "pcs"}
            disabled={!editable || !inBom}
            aria-label="Unit"
            className="w-14"
            onCommit={(v) => upd("Edit unit", (x) => (v.trim() ? (x.info.unity = v.trim()) : delete x.info.unity))}
          />
        </div>
      </Row>
      <Row label="Supplier">
        <Commit value={e.info.supplier ?? ""} placeholder={def?.info.supplier ?? ""} disabled={!editable || !inBom} aria-label="Supplier" onCommit={(v) => upd("Edit supplier", (x) => (v.trim() ? (x.info.supplier = v.trim()) : delete x.info.supplier))} />
      </Row>
      <Row label="Placement">
        <div className="flex items-center gap-1">
          <NativeSelect value={at} disabled={!editable} onChange={(ev) => setLayout("Info placement", { at: ev.target.value as InfoPlacement })} aria-label="Info placement">
            <option value="auto">Under reference</option>
            <option value="right">Right of symbol</option>
            <option value="left">Left of symbol</option>
            <option value="below">Below symbol</option>
            {at === "free" && <option value="free">Where I dragged it</option>}
          </NativeSelect>
          <div className="flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Alignment">
            {(
              [
                ["left", <AlignLeft key="l" />, "Align left"],
                ["center", <AlignCenter key="c" />, "Center"],
                ["right", <AlignRight key="r" />, "Align right"],
              ] as const
            ).map(([v, icon, label]) => (
              <Tip key={v} content={label}>
                <Button variant="tool" size="icon-sm" className="!size-6" active={(align ?? "left") === v} disabled={!editable} aria-label={label} aria-pressed={(align ?? "left") === v} onClick={() => setLayout(label, { align: v })}>
                  {icon}
                </Button>
              </Tip>
            ))}
          </div>
        </div>
      </Row>
      <p className="text-2xs text-subtle">Drag the info on the canvas to place it anywhere (it follows the component). Font, size and color of each line are set in Global styles.</p>
    </Section>
  );
}

/** Outline box around the component: on/off, colour, line style (solid, dashed, dotted, dash-dot). */
function FrameRow({ e, styles, editable, upd }: { e: ElemInst; styles: ReturnType<typeof docStyles>; editable: boolean; upd: (l: string, f: (x: ElemInst) => void) => void }) {
  const f = { ...DEFAULT_FRAME, ...(styles.graphics.frame ?? {}), ...(e.frame ?? {}) };
  const set = (label: string, p: Partial<typeof f>) => upd(label, (x) => (x.frame = { ...(x.frame ?? {}), ...p }));
  return (
    <Row label="Outline" hint={f.show ? "A box around the symbol; the symbol keeps its colours" : undefined}>
      <div className="flex items-center gap-1">
        <Switch checked={f.show} disabled={!editable} aria-label="Show outline" onCheckedChange={(v) => set(v ? "Show outline" : "Hide outline", { show: v })} />
        {f.show && (
          <>
            <ColorInput value={f.color} disabled={!editable} onChange={(v) => set("Outline color", { color: v })} />
            <NativeSelect value={f.dash} disabled={!editable} aria-label="Outline line style" onChange={(ev) => set("Outline style", { dash: ev.target.value as typeof f.dash })}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dashdot">Dash-dot</option>
            </NativeSelect>
          </>
        )}
        <Overridden on={!!e.frame} onReset={() => upd("Reset outline", (x) => (x.frame = undefined))} />
      </div>
    </Row>
  );
}

/** Terminal: its strip and number, what it connects to, and a way into the strip editor. */
function TerminalSection({ e, doc }: { e: ElemInst; doc: Doc }) {
  const ui = useEditorUI();
  const ref = parseTerminalRef(e.info.label ?? "");
  const row = useMemo(() => collectStrips(doc).find((v) => v.tag === ref.tag)?.rows.find((r) => r.instances.some((x) => x.el === e.id)), [doc, ref.tag, e.id]);
  return (
    <Section title="Terminal">
      <Row label="Strip">
        <span className="text-xs">
          {ref.tag || <span className="text-subtle">no reference</span>}
          {ref.num ? (
            <>
              {" "}
              · terminal <b>{ref.num}</b>
            </>
          ) : (
            <span className="text-warning"> · not numbered</span>
          )}
        </span>
      </Row>
      {row && (
        <>
          <Row label="Type">
            <span className="text-xs">{terminalTypeLabel(row.type)}{row.row?.bridge ? " · bridged to next" : ""}</span>
          </Row>
          <Row label="Side 1">
            <span className="text-2xs">{row.side1.join("; ") || "—"}</span>
          </Row>
          <Row label="Side 2">
            <span className="text-2xs">{row.side2.join("; ") || "—"}</span>
          </Row>
        </>
      )}
      <Button size="xs" variant="secondary" onClick={() => ui.openDialog("terminals", { tag: ref.tag })}>
        Open terminal strip {ref.tag}…
      </Button>
    </Section>
  );
}

function runMove(pageId: string, e: ElemInst, dx: number, dy: number) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
  import("@/core/ops").then(({ moveSelection, getPage }) =>
    useEditor.getState().apply("Move", (d) => moveSelection(d, getPage(d, pageId), { ...emptySel(), elements: [e.id] }, { x: dx, y: dy })),
  );
}

function PinToggles({ e, editable, styles, upd }: { e: ElemInst; editable: boolean; styles: ReturnType<typeof docStyles>; upd: (l: string, f: (x: ElemInst) => void) => void }) {
  const num = e.showPinNumbers ?? styles.text.pinNumber.visible;
  const name = e.showPinNames ?? styles.text.pinName.visible;
  return (
    <div className="flex items-center gap-1">
      <Tip content={num ? "Hide pin numbers" : "Show pin numbers"}>
        <Button variant="tool" size="xs" active={num} disabled={!editable} onClick={() => upd("Pin numbers", (x) => (x.showPinNumbers = !num))}>
          123
        </Button>
      </Tip>
      <Tip content={name ? "Hide pin names" : "Show pin names"}>
        <Button variant="tool" size="xs" active={name} disabled={!editable} onClick={() => upd("Pin names", (x) => (x.showPinNames = !name))}>
          abc
        </Button>
      </Tip>
    </div>
  );
}

function TextStyleRow({ t, e, editable, styles, upd }: { t: PlacedText; e: ElemInst; editable: boolean; styles: ReturnType<typeof docStyles>; upd: (l: string, f: (x: ElemInst) => void) => void }) {
  const base = styles.text[t.role];
  const eff = { ...base, ...(t.override ?? {}) };
  const setO = (label: string, o: Partial<TextStyle>) =>
    upd(label, (x) => {
      const y = x.texts.find((z) => z.id === t.id);
      if (y) y.override = { ...(y.override ?? {}), ...o };
    });
  const value = t.info ? e.info[t.info] ?? "" : t.text;
  return (
    <div className="rounded-md border border-border p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="truncate text-2xs font-medium">{t.info ? INFO_LABEL[t.info] ?? t.info : "Text"}</span>
        <span className="truncate text-2xs text-subtle">“{value || "—"}”</span>
        <Overridden on={!!t.override && Object.keys(t.override).length > 0} onReset={() => upd("Reset text style", (x) => { const y = x.texts.find((z) => z.id === t.id); if (y) y.override = undefined; })} />
        <button className="ml-auto text-subtle hover:text-fg" aria-label={eff.visible ? "Hide text" : "Show text"} disabled={!editable} onClick={() => setO("Toggle text", { visible: !eff.visible })}>
          {eff.visible ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
        </button>
      </div>
      <div className="grid grid-cols-[1fr_52px_28px] gap-1">
        <NativeSelect
          value={t.role}
          disabled={!editable}
          aria-label="Style role"
          onChange={(ev) =>
            upd("Text role", (x) => {
              const y = x.texts.find((z) => z.id === t.id);
              if (y) y.role = ev.target.value as TextRole;
            })
          }
        >
          {TEXT_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
        <Commit type="number" value={eff.size} step={0.5} disabled={!editable} aria-label="Font size (pt)" onCommit={(v) => setO("Text size", { size: Number(v) || base.size })} />
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(eff.color) ? eff.color : "#000000"} disabled={!editable} onChange={(ev) => setO("Text color", { color: ev.target.value })} className="h-7 w-7 cursor-pointer rounded border border-border bg-panel p-0.5" aria-label="Text color" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function endLabel(doc: Doc, page: Page, end: WireEnd): { text: string; ok: boolean } {
  if (end.k === "free") return { text: "Dangling (not connected)", ok: false };
  if (end.k === "junction") return { text: "Junction", ok: true };
  const e = page.elements.find((x) => x.id === end.el);
  const def = e && doc.defs[e.defId];
  const pin = def?.pins.find((p) => p.id === end.pin);
  return { text: `${e?.info.label || def?.name || "?"} : ${pin?.number || pin?.name || "pin"}`, ok: true };
}

function WireInspector({ w, page, doc, editable }: { w: Wire; page: Page; doc: Doc; editable: boolean }) {
  const styles = docStyles(doc);
  const ui = useEditorUI();
  const base: LineStyle = w.bus ? styles.graphics.bus : styles.graphics.wire;
  const eff = { ...base, ...(w.override ?? {}) };
  const s = useEditor.getState;
  const upd = (label: string, fn: (x: Wire) => void) =>
    s().apply(label, (d) => {
      const x = getPage(d, page.id).wires.find((y) => y.id === w.id);
      if (x) fn(x);
    });
  const a = endLabel(doc, page, w.a), b = endLabel(doc, page, w.b);
  const wi = wireInfo(doc, w);
  const autoPos = useMemo(() => {
    // where the automatic placement puts the texts, as a fraction of the wire length (for the slider)
    const { p } = wireTextAnchor(doc, w, docStyles(doc), measureText);
    let acc = 0, best = { d: Infinity, at: 0.5 };
    const total = polylineLength(w.pts) || 1;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
      const d = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y);
      if (d < best.d) best = { d, at: (acc + t * len) / total };
      acc += len;
    }
    return Math.min(0.95, Math.max(0.05, best.at));
  }, [doc, w]);
  const conductorLook = wi.look && (wi.colorSource !== "standard" || wiringOf(doc).colorize) ? wi.look : null;
  return (
    <div>
      <Section title="Wire">
        <Row
          label="Label / No."
          hint={doc.wireNumbering ? (w.labelLocked ? "Locked: automatic wire numbering keeps this number." : "Typing a number locks it against automatic numbering.") : undefined}
        >
          <div className="flex items-center gap-1">
            <Commit
              value={w.label ?? ""}
              disabled={!editable}
              onCommit={(v) =>
                upd("Wire label", (x) => {
                  x.label = v || undefined;
                  // a number typed by hand is kept by automatic numbering
                  if (doc.wireNumbering) x.labelLocked = !!v || undefined;
                })
              }
            />
            <Button variant="tool" size="icon-sm" active={!!w.labelLocked} disabled={!editable} onClick={() => upd(w.labelLocked ? "Unlock wire number" : "Lock wire number", (x) => (x.labelLocked = !x.labelLocked || undefined))} aria-label={w.labelLocked ? "Unlock wire number" : "Lock wire number"} title={w.labelLocked ? "Unlock: automatic numbering may change it" : "Lock against automatic numbering"}>
              {w.labelLocked ? <Lock /> : <Unlock />}
            </Button>
          </div>
        </Row>
        {(["a", "b"] as const).map((end) => {
          const here = endAddress(doc, page, w[end]);
          const auto = wireEndLabel(doc, page, w, end, (wiringOf(doc).numberAt ?? "middle") !== "middle", !!wiringOf(doc).destination);
          return (
            <Row key={end} label={here ? `At ${here}` : end === "a" ? "At start" : "At end"} hint={end === "b" && !w.endLabels ? "Names written at each end of the wire (wire markers). Leave empty for automatic." : undefined}>
              <Commit
                value={w.endLabels?.[end] ?? ""}
                placeholder={auto || "—"}
                disabled={!editable}
                onCommit={(v) =>
                  upd("Wire end name", (x) => {
                    const e = { ...(x.endLabels ?? {}), [end]: v.trim() || undefined };
                    x.endLabels = e.a || e.b ? e : undefined;
                  })
                }
                aria-label={`Name at ${here ?? end}`}
              />
            </Row>
          );
        })}
        <Row label="Text position" hint={w.labelPos === undefined ? "Automatic: middle of the longest straight run. Drag to place the number and color/size along the wire." : undefined}>
          <div className="flex items-center gap-2">
            <input type="range" min={0.05} max={0.95} step={0.01} value={w.labelPos ?? autoPos} disabled={!editable} onChange={(ev) => upd("Text position", (x) => (x.labelPos = Number(ev.target.value)))} className={cn("w-full accent-[var(--accent)]", w.labelPos === undefined && "opacity-60")} aria-label="Text position" />
            <Button variant="tool" size="xs" active={w.labelPos === undefined} disabled={!editable} onClick={() => upd("Automatic text position", (x) => (x.labelPos = undefined))}>
              Auto
            </Button>
          </div>
        </Row>
        <Row label="Labels">
          <Button size="xs" variant="secondary" onClick={() => ui.openDialog("wireLabels", { scope: "selection" })}>
            <Printer /> Print wire labels
          </Button>
        </Row>
        <Row label="Bus">
          <Switch checked={!!w.bus} disabled={!editable} onCheckedChange={(v) => upd("Bus", (x) => (x.bus = v))} />
        </Row>
        <Row label="Length">
          <span className="text-xs tabular">{Math.round(polylineLength(w.pts))} units · {w.pts.length - 1} segments</span>
        </Row>
      </Section>
      <ConductorSection wires={[w]} page={page} doc={doc} editable={editable} />
      <XrefSection id={w.id} />
      <Section title="Connections">
        {[
          ["From", a],
          ["To", b],
        ].map(([l, x]) => (
          <Row key={l as string} label={l as string}>
            <span className={cn("text-xs", !(x as { ok: boolean }).ok && "font-medium text-danger")}>{(x as { text: string }).text}</span>
          </Row>
        ))}
        <Button size="xs" variant="secondary" onClick={() => runCommand("selectNet", ui)}>
          Select connected net
        </Button>
      </Section>
      <Section title="Appearance" actions={<Overridden on={!!w.override} onReset={() => upd("Reset wire style", (x) => (x.override = undefined))} />}>
        <Row label="Color" hint={conductorLook ? `Drawn in the conductor color ${conductorLook.code} (${conductorLook.name}). Clear it in Conductor to use this color.` : undefined}>
          {conductorLook ? (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Swatch code={conductorLook.code} /> {conductorLook.name}
            </span>
          ) : (
            <ColorInput value={eff.color} disabled={!editable} onChange={(v) => upd("Wire color", (x) => (x.override = { ...(x.override ?? {}), color: v }))} />
          )}
        </Row>
        <Row label="Thickness">
          <Commit type="number" step={0.25} value={eff.width} disabled={!editable} onCommit={(v) => upd("Wire thickness", (x) => (x.override = { ...(x.override ?? {}), width: Math.max(0.25, Number(v) || 1) }))} />
        </Row>
        <Row label="Line">
          <NativeSelect value={eff.dash} disabled={!editable} onChange={(ev) => upd("Wire line style", (x) => (x.override = { ...(x.override ?? {}), dash: ev.target.value as LineStyle["dash"] }))}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dashdot">Dash-dot</option>
          </NativeSelect>
        </Row>
      </Section>
    </div>
  );
}

const SHAPE_NAMES: Record<Shape["kind"], string> = { line: "Line", rect: "Rectangle", ellipse: "Ellipse", polygon: "Polygon / polyline" };

function ShapeInspector({ ids, page, editable }: { ids: string[]; page: Page; editable: boolean }) {
  const list = page.shapes.filter((x) => ids.includes(x.id));
  if (!list.length) return null;
  const first = list[0];
  const same = <K extends keyof Shape>(k: K) => (list.every((x) => JSON.stringify(x[k]) === JSON.stringify(first[k])) ? first[k] : undefined);
  const s = useEditor.getState;
  const upd = (label: string, fn: (x: Shape) => void) =>
    s().apply(label, (d) => {
      const set = new Set(ids);
      for (const x of getPage(d, page.id).shapes) if (set.has(x.id)) fn(x);
    });
  // the shape tool draws the next shapes in the style last set here
  const remember = (p: Partial<ReturnType<typeof s>["shapeStyle"]>) => s().set("shapeStyle", { ...s().shapeStyle, ...p });
  const closable = list.filter((x) => x.kind === "polygon");
  const fillable = list.some((x) => x.kind !== "line" && !(x.kind === "polygon" && x.closed === false));
  const kinds = [...new Set(list.map((x) => SHAPE_NAMES[x.kind]))];
  const title = list.length === 1 ? (first.image ? "Picture" : SHAPE_NAMES[first.kind]) : `${list.length} drawing shapes`;
  const pic = list.length === 1 && first.image ? first.image : null;
  return (
    <div>
      {pic && (
        <Section title="Picture">
          <div className="flex h-24 items-center justify-center rounded border border-border bg-white">
            <img src={logoDataUrl(pic)} alt="" className="max-h-full max-w-full object-contain p-1" />
          </div>
          <p className="truncate text-2xs text-muted">
            {pic.name ?? "picture"} · {Math.max(1, Math.round(logoBytes(pic) / 1024))} KB · drawn fitted inside its box (never stretched)
          </p>
          {editable && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                onClick={() =>
                  upd("Fit box to picture", (x) => {
                    const n = x.image && logoSize(x.image);
                    if (!n || x.pts.length < 2) return;
                    const [a, c] = x.pts;
                    const w = Math.abs(c.x - a.x);
                    x.pts = [{ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) }, { x: Math.min(a.x, c.x) + w, y: Math.min(a.y, c.y) + (w * n.h) / n.w }];
                  })
                }
              >
                Fit box to picture
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";
                  input.onchange = async () => {
                    const f = input.files?.[0];
                    if (!f) return;
                    try {
                      const { name, logo } = await readLogoFile(f, PICTURE_LIMITS);
                      upd("Replace picture", (x) => void (x.image = { ...logo, name }));
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  };
                  input.click();
                }}
              >
                Replace…
              </Button>
              <Button size="xs" onClick={() => upd(first.width > 0 ? "Remove frame" : "Add frame", (x) => void (x.width = x.width > 0 ? 0 : 1))}>
                {first.width > 0 ? "Remove frame" : "Add frame"}
              </Button>
            </div>
          )}
        </Section>
      )}
      <Section title={title} defaultOpen={!pic}>
        {list.length > 1 && (
          <Row label="Kinds">
            <span className="text-xs">{kinds.join(", ")}</span>
          </Row>
        )}
        {list.length === 1 && (first.kind === "line" || first.kind === "polygon") && (
          <Row label="Length">
            <span className="text-xs tabular">
              {Math.round(polylineLength(first.kind === "polygon" && first.closed !== false ? [...first.pts, first.pts[0]] : first.pts))} units
            </span>
          </Row>
        )}
        {closable.length > 0 && (
          <Row label="Closed">
            <Switch checked={closable.every((x) => x.closed !== false)} disabled={!editable} onCheckedChange={(v) => upd(v ? "Close shape" : "Open shape", (x) => void (x.kind === "polygon" && (x.closed = v)))} />
          </Row>
        )}
        <p className="text-2xs text-subtle">Drag to move, drag the square handles to reshape, Delete to remove.</p>
      </Section>
      <Section title="Appearance">
        <Row label="Color">
          <ColorInput value={same("color") ?? first.color} disabled={!editable} onChange={(v) => (upd("Shape color", (x) => (x.color = v)), remember({ color: v }))} />
        </Row>
        <Row label="Thickness">
          <Commit type="number" step={0.25} value={same("width") ?? ""} disabled={!editable} onCommit={(v) => Number(v) > 0 && (upd("Shape thickness", (x) => (x.width = Number(v))), remember({ width: Number(v) }))} />
        </Row>
        <Row label="Line">
          <NativeSelect value={same("dash") ?? ""} disabled={!editable} onChange={(ev) => (upd("Shape line style", (x) => (x.dash = ev.target.value as Shape["dash"])), remember({ dash: ev.target.value as Shape["dash"] }))}>
            {same("dash") === undefined && <option value="">Mixed</option>}
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dashdot">Dash-dot</option>
          </NativeSelect>
        </Row>
        {fillable && (
          <Row label="Fill">
            <div className="flex items-center gap-2">
              <Switch checked={list.some((x) => !!x.fill)} disabled={!editable} onCheckedChange={(v) => upd(v ? "Fill shape" : "Remove fill", (x) => void (x.kind !== "line" && (x.fill = v ? x.fill ?? "#e5e7eb" : null)))} />
              {list.some((x) => !!x.fill) && <ColorInput value={list.find((x) => x.fill)?.fill ?? "#e5e7eb"} disabled={!editable} onChange={(v) => upd("Fill color", (x) => void (x.fill && (x.fill = v)))} />}
            </div>
          </Row>
        )}
      </Section>
    </div>
  );
}

function MultiInspector() {
  const sel = useEditor((s) => s.sel);
  const page = useEditor((s) => s.page());
  const doc = useEditor((s) => s.doc);
  const selWires = useMemo(() => page.wires.filter((w) => sel.wires.includes(w.id)), [page.wires, sel.wires]);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [loc, setLoc] = useState("");
  const run = (id: string) => runCommand(id, ui);
  return (
    <div>
      <Section title="Selection">
        <p className="text-xs text-muted">
          {[
            [sel.elements.length, "component"],
            [sel.wires.length, "wire"],
            [sel.junctions.length, "junction"],
            [sel.texts.length, "text"],
            [sel.shapes?.length ?? 0, "drawing shape"],
          ]
            .filter(([n]) => n)
            .map(([n, l]) => `${n} ${l}${n === 1 ? "" : "s"}`)
            .join(" · ")}
        </p>
        {editable && sel.elements.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <Button size="xs" onClick={() => run("rotate")}>
              Rotate
            </Button>
            <Button size="xs" onClick={() => run("mirror")}>
              Mirror
            </Button>
            <Button size="xs" onClick={() => run("lock")}>
              Lock/unlock
            </Button>
            <Button size="xs" onClick={() => run("resetText")}>
              Default label placement
            </Button>
            <Button size="xs" onClick={() => run("resetOverrides")}>
              Reset overrides
            </Button>
          </div>
        )}
      </Section>
      {selWires.length > 0 && <ConductorSection wires={selWires} page={page} doc={doc} editable={editable} />}
      {editable && sel.elements.length > 1 && (
        <Section title="Arrange">
          <div className="grid grid-cols-3 gap-1">
            {(["left", "center", "right", "top", "middle", "bottom"] as const).map((a) => (
              <Button key={a} size="xs" variant="secondary" onClick={() => run("align-" + a)}>
                {a}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Button size="xs" variant="secondary" onClick={() => run("distH")} disabled={sel.elements.length < 3}>
              Distribute ↔
            </Button>
            <Button size="xs" variant="secondary" onClick={() => run("distV")} disabled={sel.elements.length < 3}>
              Distribute ↕
            </Button>
          </div>
        </Section>
      )}
      {editable && sel.elements.length > 0 && (
        <Section title="Bulk edit">
          <Row label="Location">
            <div className="flex gap-1">
              <Input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="e.g. +CAB1" onKeyDown={(e) => e.stopPropagation()} />
              <Button
                size="sm"
                disabled={!loc}
                onClick={() =>
                  useEditor.getState().apply("Set location", (d) => {
                    for (const e of getPage(d, page.id).elements) if (sel.elements.includes(e.id)) e.info.location = loc;
                  })
                }
              >
                Set
              </Button>
            </div>
          </Row>
        </Section>
      )}
    </div>
  );
}

function BlockSection({ e, page, editable }: { e: ElemInst; page: Page; editable: boolean }) {
  const g = e.group!;
  const ui = useEditorUI();
  const [latest, setLatest] = useState<number | null>(null);
  useEffect(() => {
    fetch(`/api/library/status?ids=${g.blockId}`)
      .then((r) => (r.ok ? r.json() : { items: {} }))
      .then((j: { items: Record<string, { revision: number } | null> }) => setLatest(j.items[g.blockId]?.revision ?? null))
      .catch(() => {});
  }, [g.blockId]);
  const s = useEditor.getState;
  const selectGroup = () => import("@/core/blocks").then(({ groupSelection }) => s().setSel(groupSelection(s().page(), g.id)));
  const update = async () => {
    const [{ fetchBlock }, { updateBlockInstance }] = await Promise.all([import("./blocks"), import("@/core/blocks")]);
    const b = await fetchBlock(g.blockId);
    let r = { added: 0, removed: 0, updated: 0 };
    s().apply(`Update block ${g.name} to rev ${b.revision}`, (d) => {
      r = updateBlockInstance(d, getPage(d, page.id), g.id, b.revision, b.content);
    });
    ui.toast(`Block updated: ${r.updated} kept, ${r.added} added, ${r.removed} removed`, { undo: true });
  };
  const detach = () => import("@/core/blocks").then(({ detachGroup }) => s().apply("Detach block instance", (d) => detachGroup(getPage(d, page.id), g.id)));
  const setMode = (mode: "linked" | "derived") =>
    s().apply("Block link mode", (d) => {
      const p = getPage(d, page.id);
      for (const x of [...p.elements, ...p.wires, ...p.junctions]) if (x.group?.id === g.id) x.group = { ...x.group, mode };
    });
  const outdated = latest !== null && latest > g.revision;
  return (
    <Section title="Reusable block">
      <Row label="Block">
        <span className="truncate text-xs font-medium">{g.name}</span>
      </Row>
      <Row label="Revision">
        <span className="flex items-center gap-1.5 text-xs">
          rev {g.revision}
          {outdated && <Badge tone="warning">rev {latest} available</Badge>}
          {latest === null && <Badge>source unavailable</Badge>}
        </span>
      </Row>
      <Row label="Link">
        <NativeSelect value={g.mode} disabled={!editable} onChange={(ev) => setMode(ev.target.value as "linked" | "derived")}>
          <option value="linked">Linked — updates replace everything but references</option>
          <option value="derived">Derived — updates keep local properties</option>
        </NativeSelect>
      </Row>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="secondary" onClick={selectGroup}>
          Select block
        </Button>
        {outdated && (
          <Button size="xs" variant="primary" disabled={!editable} onClick={update}>
            Update to rev {latest}
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={!editable} onClick={detach}>
          Detach (make independent)
        </Button>
      </div>
    </Section>
  );
}

/** Other places the same label appears (component reference, wire number, QET report / master-slave link). */
function XrefSection({ id }: { id: string }) {
  const doc = useEditor((s) => s.doc);
  const ui = useEditorUI();
  const info = useMemo(() => {
    const x = cachedXref(doc, measureText);
    const o = x.occ.find((q) => q.id === id && q.group >= 0);
    if (!o) return null;
    return { o, list: x.groups[o.group].map((i) => x.occ[i]) };
  }, [doc, id]);
  if (!info) return null;
  const key = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <Section title={`Cross references (${info.list.length})`}>
      <ul className="space-y-0.5">
        {info.list.map((q) => (
          <li key={q.idx}>
            <button
              disabled={q.idx === info.o.idx}
              onClick={() => ui.engine.current?.goToOccurrence(q, true)}
              className={cn("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs", q.idx === info.o.idx ? "bg-accent-soft text-accent" : "hover:bg-hover")}
            >
              <span className="w-12 shrink-0 text-subtle">{q.kind === "wire" ? "wire" : q.kind === "report" ? "report" : q.kind === "link" ? "linked" : "part"}</span>
              <span className="min-w-0 flex-1 truncate">{describe(doc, q)}</span>
              {q.idx === info.o.idx && <span className="text-subtle">here</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-subtle">{key}-click a label on the canvas (or press L) to jump; {key}+[ goes back. Exported PDFs keep these as links.</p>
    </Section>
  );
}
