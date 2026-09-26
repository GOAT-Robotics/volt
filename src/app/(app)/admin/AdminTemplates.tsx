"use client";
import * as React from "react";
import { Plus, Palette, LayoutTemplate, Check, Star, Archive, Save, ArrowUp, ArrowDown, Trash2, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Empty, Spinner, Switch, Table } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, fmtDate } from "@/lib/utils";
import { TEXT_ROLES, type Styles, type TextRole, type NumberingRule } from "@/core/model";
import type { ProjectTemplateContent } from "@/lib/templates";
import { Section, TagInput, useMutation } from "@/components/volt/common";
import type { AdminData } from "./AdminView";

const ROLE_NAMES: Record<TextRole, string> = {
  componentName: "Component name",
  componentRef: "Component reference",
  connectorName: "Connector name",
  pinNumber: "Pin number",
  pinName: "Pin name",
  wireLabel: "Wire label",
  cableLabel: "Cable label",
  terminalLabel: "Terminal label",
  annotation: "Annotation",
  pageTitle: "Page title",
  titleBlockField: "Title block field",
  revisionTable: "Revision table",
};

function TemplateList<T extends { id: string; name: string; version: number; status: string; isDefault: boolean }>({ items, selected, onSelect, icon }: { items: T[]; selected: string | null; onSelect: (id: string) => void; icon: React.ReactNode }) {
  return (
    <ul className="space-y-1" role="listbox" aria-label="Templates">
      {items.map((t) => (
        <li key={t.id}>
          <button
            role="option"
            aria-selected={selected === t.id}
            onClick={() => onSelect(t.id)}
            className={cn("flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left", selected === t.id ? "border-accent bg-accent-soft" : "border-transparent hover:bg-hover")}
          >
            <span className="text-muted [&_svg]:size-3.5">{icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{t.name}</span>
              <span className="block text-2xs text-muted">Version {t.version}</span>
            </span>
            {t.isDefault && <Star className="size-3 text-amber-500" fill="currentColor" aria-label="Default" />}
            <StatusBadge status={t.status === "RETIRED" ? "DEPRECATED" : t.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function HistoryList({ history }: { history: { version: number; action: string; at: string; by: string; note?: string }[] }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium">
        <History className="size-3.5 text-muted" /> History ({history.length})
      </summary>
      <ol className="max-h-56 overflow-auto border-t border-border">
        {[...history].reverse().map((h, i) => (
          <li key={i} className="flex gap-2 px-3 py-1 text-2xs">
            <span className="w-8 font-mono text-muted">v{h.version}</span>
            <span className="w-16 font-medium capitalize">{h.action}</span>
            <span className="flex-1 text-muted">
              {h.by}
              {h.note ? ` — ${h.note}` : ""}
            </span>
            <span className="text-muted">{fmtDate(h.at)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function TemplateActions({ kind, t, run, busy }: { kind: "style-templates" | "project-templates"; t: { id: string; status: string; isDefault: boolean; history: { action: string }[] }; run: ReturnType<typeof useMutation>[0]; busy: boolean }) {
  const act = (action: string, msg: string) => run(() => api(`/api/admin/${kind}/${t.id}`, { method: "PATCH", json: { action } }), msg);
  const everApproved = t.status === "APPROVED" || t.history.some((h) => h.action === "approve");
  return (
    <div className="flex flex-wrap gap-1.5">
      {t.status === "DRAFT" && (
        <Button size="xs" onClick={() => act("approve", "Template approved")} disabled={busy}>
          <Check /> Approve
        </Button>
      )}
      {!t.isDefault && t.status !== "RETIRED" && (
        <Button size="xs" onClick={() => act("setDefault", "Default template changed")} disabled={busy || (kind === "project-templates" ? t.status !== "APPROVED" : !everApproved)}>
          <Star /> Set as default
        </Button>
      )}
      {t.status !== "RETIRED" ? (
        <Button size="xs" variant="danger-ghost" onClick={() => act("retire", "Template retired")} disabled={busy}>
          <Archive /> Retire
        </Button>
      ) : (
        <Button size="xs" onClick={() => act("reactivate", "Template reactivated as draft")} disabled={busy}>
          <RotateCcw /> Reactivate
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Style templates                                                      */
/* ------------------------------------------------------------------ */

export function StyleTemplatesTab({ data }: { data: AdminData }) {
  const [sel, setSel] = React.useState<string | null>(data.styleTemplates[0]?.id ?? null);
  const [creating, setCreating] = React.useState(false);
  const t = data.styleTemplates.find((x) => x.id === sel) ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Section
        className="self-start"
        title="Style templates"
        description="Text & graphic styles for new drawings"
        actions={
          <Button size="xs" variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New
          </Button>
        }
      >
        <div className="p-2">
          {data.styleTemplates.length ? (
            <TemplateList items={data.styleTemplates} selected={sel} onSelect={setSel} icon={<Palette />} />
          ) : (
            <Empty icon={<Palette />} title="No style templates">New projects use Volt’s built-in styles. Create a template from them to set your house style.</Empty>
          )}
        </div>
      </Section>
      {t ? <StyleEditor key={`${t.id}:${t.version}:${t.status}`} t={t} /> : <div />}
      {creating && <CreateDialog kind="style-templates" onClose={() => setCreating(false)} onCreated={setSel} sources={data.styleTemplates.map((x) => ({ id: x.id, label: x.name }))} />}
    </div>
  );
}

function CreateDialog({ kind, onClose, onCreated, sources, versions }: { kind: "style-templates" | "project-templates"; onClose: () => void; onCreated: (id: string) => void; sources?: { id: string; label: string }[]; versions?: { id: string; label: string }[] }) {
  const [run, busy] = useMutation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [from, setFrom] = React.useState("");
  const style = kind === "style-templates";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={style ? "New style template" : "New project template"} description={style ? "Start from Volt’s built-in styles or copy an existing template." : "Start blank or derive page structure, title block, styles and numbering from an existing project version."}>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const j = await run(
              () => api<{ id: string }>(`/api/admin/${kind}`, { method: "POST", json: style ? { name, fromId: from || null } : { name, description, fromVersionId: from || null } }),
              "Template created",
            );
            if (j) {
              onCreated(j.id);
              onClose();
            }
          }}
        >
          <Field label="Name *">
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          {!style && (
            <Field label="Description">
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          )}
          <Field label="Start from">
            <NativeSelect value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{style ? "Built-in defaults" : "Blank template"}</option>
              {(style ? sources : versions)?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy && <Spinner />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="size-6 cursor-pointer rounded border border-border bg-panel p-0.5" aria-label={label} />
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-20 font-mono text-2xs" aria-label={`${label} hex`} />
    </span>
  );
}

function StyleEditor({ t }: { t: AdminData["styleTemplates"][number] }) {
  const [run, busy] = useMutation();
  const [name, setName] = React.useState(t.name);
  const [st, setSt] = React.useState<Styles>(t.styles);
  const [note, setNote] = React.useState("");
  const dirty = name !== t.name || JSON.stringify(st) !== JSON.stringify(t.styles);
  const text = (r: TextRole, patch: Partial<Styles["text"][TextRole]>) => setSt((s) => ({ ...s, text: { ...s.text, [r]: { ...s.text[r], ...patch } } }));
  const g = <K extends keyof Styles["graphics"]>(k: K, patch: Partial<Styles["graphics"][K]>) => setSt((s) => ({ ...s, graphics: { ...s.graphics, [k]: { ...(s.graphics[k] as object), ...patch } } }));
  const G = st.graphics;
  const num = (v: number, set: (n: number) => void, label: string, step = 0.5) => <Input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))} className="w-16 text-right tabular-nums" aria-label={label} />;
  return (
    <div className="min-w-0 space-y-4">
      <Section
        title={
          <span className="flex items-center gap-2">
            {t.name} <StatusBadge status={t.status === "RETIRED" ? "DEPRECATED" : t.status} /> {t.isDefault && <Badge tone="warning">Default</Badge>}
          </span>
        }
        description={`Version ${t.version} · updated ${fmtDate(t.updatedAt)}${t.status === "DRAFT" && t.isDefault ? " · new projects keep using the last approved version until you approve this one" : ""}`}
        actions={<TemplateActions kind="style-templates" t={t} run={run} busy={busy} />}
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Change note" hint="Recorded in the template history.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Larger reference font for A3 prints" />
          </Field>
        </div>
      </Section>
      <Section title="Text roles">
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Font</th>
                <th className="w-20">Size</th>
                <th className="w-24">Weight</th>
                <th className="w-14 text-center">Italic</th>
                <th>Color</th>
                <th className="w-14 text-center">Visible</th>
              </tr>
            </thead>
            <tbody>
              {TEXT_ROLES.map((r) => {
                const x = st.text[r];
                return (
                  <tr key={r}>
                    <td className="text-xs font-medium">{ROLE_NAMES[r]}</td>
                    <td>
                      <Input value={x.font} onChange={(e) => text(r, { font: e.target.value })} className="w-40" aria-label={`${ROLE_NAMES[r]} font`} />
                    </td>
                    <td>{num(x.size, (n) => text(r, { size: n }), `${ROLE_NAMES[r]} size`)}</td>
                    <td>
                      <NativeSelect value={x.weight} onChange={(e) => text(r, { weight: Number(e.target.value) })} aria-label={`${ROLE_NAMES[r]} weight`}>
                        {[300, 400, 500, 600, 700].map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </NativeSelect>
                    </td>
                    <td className="text-center">
                      <Checkbox className="mx-auto" checked={x.italic} onCheckedChange={(c) => text(r, { italic: !!c })} aria-label={`${ROLE_NAMES[r]} italic`} />
                    </td>
                    <td>
                      <ColorInput value={x.color} onChange={(v) => text(r, { color: v })} label={`${ROLE_NAMES[r]} color`} />
                    </td>
                    <td className="text-center">
                      <Checkbox className="mx-auto" checked={x.visible} onCheckedChange={(c) => text(r, { visible: !!c })} aria-label={`${ROLE_NAMES[r]} visible`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </Section>
      <Section title="Key graphics">
        <div className="grid gap-x-6 gap-y-3 p-4 md:grid-cols-2">
          <GRow label="Wire">
            <ColorInput value={G.wire.color} onChange={(v) => g("wire", { color: v })} label="Wire color" />
            {num(G.wire.width, (n) => g("wire", { width: n }), "Wire width")}
          </GRow>
          <GRow label="Junction">
            <ColorInput value={G.wire.junctionColor} onChange={(v) => g("wire", { junctionColor: v })} label="Junction color" />
            {num(G.wire.junctionRadius, (n) => g("wire", { junctionRadius: n }), "Junction radius")}
          </GRow>
          <GRow label="Bus">
            <ColorInput value={G.bus.color} onChange={(v) => g("bus", { color: v })} label="Bus color" />
            {num(G.bus.width, (n) => g("bus", { width: n }), "Bus width")}
          </GRow>
          <GRow label="Pins">
            <ColorInput value={G.pin.color} onChange={(v) => g("pin", { color: v })} label="Pin color" />
            {num(G.pin.size, (n) => g("pin", { size: n }), "Pin size")}
            <label className="flex items-center gap-1 text-2xs">
              <Switch checked={G.pin.showPoint} onCheckedChange={(c) => g("pin", { showPoint: c })} aria-label="Show pin points" /> points
            </label>
          </GRow>
          <GRow label="Border">
            <ColorInput value={G.border.color} onChange={(v) => g("border", { color: v })} label="Border color" />
            <ColorInput value={G.border.headerColor} onChange={(v) => g("border", { headerColor: v })} label="Border header color" />
          </GRow>
          <GRow label="Title block">
            <ColorInput value={G.titleBlock.color} onChange={(v) => g("titleBlock", { color: v })} label="Title block color" />
            {num(G.titleBlock.width, (n) => g("titleBlock", { width: n }), "Title block line width")}
          </GRow>
        </div>
      </Section>
      <HistoryList history={t.history} />
      <div className="sticky bottom-3 z-10 flex justify-end gap-2 rounded-lg border border-border bg-panel/95 px-4 py-2.5 shadow-float backdrop-blur">
        {dirty && <span className="mr-auto self-center text-2xs text-warning">Saving creates version {t.version + 1} (draft — needs approval)</span>}
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => (setSt(t.styles), setName(t.name))}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={() => run(() => api(`/api/admin/style-templates/${t.id}`, { method: "PATCH", json: { name, styles: st, note: note || undefined } }), "Saved as new version")}>
          {busy ? <Spinner /> : <Save />} Save version
        </Button>
      </div>
    </div>
  );
}

function GRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-xs font-medium">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Project templates                                                    */
/* ------------------------------------------------------------------ */

export function ProjectTemplatesTab({ data }: { data: AdminData }) {
  const [sel, setSel] = React.useState<string | null>(data.projectTemplates[0]?.id ?? null);
  const [creating, setCreating] = React.useState(false);
  const t = data.projectTemplates.find((x) => x.id === sel) ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Section
        className="self-start"
        title="Project templates"
        description="Starting points offered in “New project”"
        actions={
          <Button size="xs" variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New
          </Button>
        }
      >
        <div className="p-2">
          {data.projectTemplates.length ? (
            <TemplateList items={data.projectTemplates} selected={sel} onSelect={setSel} icon={<LayoutTemplate />} />
          ) : (
            <Empty icon={<LayoutTemplate />} title="No project templates">Create one from scratch or from an existing project version to standardise pages, title blocks and approval rules.</Empty>
          )}
        </div>
      </Section>
      {t ? <ProjectTemplateEditor key={`${t.id}:${t.version}:${t.status}`} t={t} styles={data.styleTemplates} /> : <div />}
      {creating && <CreateDialog kind="project-templates" onClose={() => setCreating(false)} onCreated={setSel} versions={data.versions} />}
    </div>
  );
}

type Override = { minApprovals?: number; sequentialDefault?: boolean; requireCommentsResolved?: boolean; signatureRequiredForRelease?: boolean; requiredSignatories?: number; allowSelfApproval?: boolean };

function ProjectTemplateEditor({ t, styles }: { t: AdminData["projectTemplates"][number]; styles: AdminData["styleTemplates"] }) {
  const [run, busy] = useMutation();
  const init = React.useMemo(
    () => ({
      name: t.name,
      description: t.description,
      pages: t.content.pages.map((p) => p.title),
      fields: Object.entries(t.content.titleBlockFields),
      styleTemplateId: t.content.styleTemplateId ?? "",
      numbering: (t.content.numbering ?? []) as NumberingRule[],
      requiredFields: t.content.requiredFields,
      approval: (t.content.approval ?? {}) as Override,
      keepSeedDoc: t.seedPages > 0,
    }),
    [t],
  );
  const [f, setF] = React.useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = () => {
    const content: Omit<ProjectTemplateContent, "doc" | "styles"> & { keepSeedDoc: boolean } = {
      pages: f.pages.filter((p) => p.trim()).map((title) => ({ title: title.trim() })),
      titleBlockFields: Object.fromEntries(f.fields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
      styleTemplateId: f.styleTemplateId || null,
      numbering: f.numbering.map((r) => ({ ...r, start: Number(r.start) || 1 })),
      requiredFields: f.requiredFields,
      approval: Object.fromEntries(Object.entries(f.approval).filter(([, v]) => v !== undefined)),
      keepSeedDoc: f.keepSeedDoc,
    };
    return run(() => api(`/api/admin/project-templates/${t.id}`, { method: "PATCH", json: { name: f.name, description: f.description, content } }), "Saved as new version");
  };
  const ov = <K extends keyof Override>(k: K, v: Override[K] | undefined) => set("approval", { ...f.approval, [k]: v });
  const overrideRow = (k: keyof Override, label: string, type: "bool" | "num") => {
    const on = f.approval[k] !== undefined;
    return (
      <div key={k} className="flex items-center gap-3 py-1">
        <Checkbox checked={on} onCheckedChange={(c) => ov(k, c ? (type === "bool" ? true : 1) : undefined)} aria-label={`Override ${label}`} />
        <span className="flex-1 text-xs">{label}</span>
        {on ? (
          type === "bool" ? (
            <Switch checked={!!f.approval[k]} onCheckedChange={(c) => ov(k, c)} aria-label={label} />
          ) : (
            <Input type="number" min={0} value={Number(f.approval[k])} onChange={(e) => ov(k, Number(e.target.value))} className="w-16 text-right" aria-label={label} />
          )
        ) : (
          <span className="text-2xs text-muted">Workspace default</span>
        )}
      </div>
    );
  };
  return (
    <div className="min-w-0 space-y-4">
      <Section
        title={
          <span className="flex items-center gap-2">
            {t.name} <StatusBadge status={t.status === "RETIRED" ? "DEPRECATED" : t.status} /> {t.isDefault && <Badge tone="warning">Default</Badge>}
          </span>
        }
        description={`Version ${t.version} · updated ${fmtDate(t.updatedAt)}${t.status === "DRAFT" ? " · only approved templates are offered in New project" : ""}`}
        actions={<TemplateActions kind="project-templates" t={t} run={run} busy={busy} />}
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Style template" hint="Base styles for projects created from this template.">
            <NativeSelect value={f.styleTemplateId} onChange={(e) => set("styleTemplateId", e.target.value)}>
              <option value="">Workspace default</option>
              {styles
                .filter((s) => s.status !== "RETIRED")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          {t.seedPages > 0 && (
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <Switch checked={f.keepSeedDoc} onCheckedChange={(c) => set("keepSeedDoc", c)} aria-label="Keep seed drawing content" />
              Keep the drawing content copied from the source version ({t.seedPages} pages)
            </label>
          )}
        </div>
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Page structure" actions={<Button size="xs" onClick={() => set("pages", [...f.pages, `Page ${f.pages.length + 1}`])}><Plus /> Page</Button>}>
          <ol className="space-y-1 p-3">
            {f.pages.map((p, i) => (
              <li key={i} className="flex items-center gap-1">
                <span className="w-5 text-right text-2xs tabular-nums text-muted">{i + 1}</span>
                <Input value={p} onChange={(e) => set("pages", f.pages.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Page ${i + 1} title`} />
                <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => set("pages", swap(f.pages, i, i - 1))}>
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === f.pages.length - 1} onClick={() => set("pages", swap(f.pages, i, i + 1))}>
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="danger-ghost" aria-label="Remove page" disabled={f.pages.length <= 1} onClick={() => set("pages", f.pages.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ol>
        </Section>
        <Section title="Title block fields" description="Default values for every page (%-variables allowed)" actions={<Button size="xs" onClick={() => set("fields", [...f.fields, ["", ""]])}><Plus /> Field</Button>}>
          <div className="space-y-1 p-3">
            {f.fields.length === 0 && <p className="text-2xs text-muted">No defaults — pages start with empty title block fields.</p>}
            {f.fields.map(([k, v], i) => (
              <div key={i} className="flex items-center gap-1">
                <Input value={k} onChange={(e) => set("fields", f.fields.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} placeholder="field" className="w-32 font-mono" aria-label="Field name" />
                <Input value={v} onChange={(e) => set("fields", f.fields.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} placeholder="value" aria-label="Field value" />
                <Button size="icon-sm" variant="danger-ghost" aria-label="Remove field" onClick={() => set("fields", f.fields.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Section
        title="Numbering rules"
        description="Tokens: {prefix} {n} {n:2} {page} {location}. Match a prefix/category or * for all."
        actions={
          <Button size="xs" onClick={() => set("numbering", [...f.numbering, { id: "", match: "*", prefix: "", scope: "project", format: "{prefix}{n}", start: 1 }])}>
            <Plus /> Rule
          </Button>
        }
      >
        {f.numbering.length === 0 ? (
          <p className="p-4 text-2xs text-muted">Using Volt’s default rule ({"{prefix}{n}"} per project).</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Match</th>
                <th>Prefix</th>
                <th>Scope</th>
                <th>Format</th>
                <th className="w-20">Start</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {f.numbering.map((r, i) => {
                const up = (patch: Partial<NumberingRule>) => set("numbering", f.numbering.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={i}>
                    <td>
                      <Input value={r.match} onChange={(e) => up({ match: e.target.value })} aria-label="Match" />
                    </td>
                    <td>
                      <Input value={r.prefix} onChange={(e) => up({ prefix: e.target.value })} aria-label="Prefix" />
                    </td>
                    <td>
                      <NativeSelect value={r.scope} onChange={(e) => up({ scope: e.target.value as NumberingRule["scope"] })} aria-label="Scope">
                        <option value="project">Project</option>
                        <option value="page">Page</option>
                        <option value="location">Location</option>
                      </NativeSelect>
                    </td>
                    <td>
                      <Input value={r.format} onChange={(e) => up({ format: e.target.value })} className="font-mono" aria-label="Format" />
                    </td>
                    <td>
                      <Input type="number" min={0} value={r.start} onChange={(e) => up({ start: Number(e.target.value) })} aria-label="Start" />
                    </td>
                    <td>
                      <Button size="icon-sm" variant="danger-ghost" aria-label="Remove rule" onClick={() => set("numbering", f.numbering.filter((_, j) => j !== i))}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Required metadata" description="Project properties that must be filled at creation and before submission.">
          <div className="p-3">
            <TagInput value={f.requiredFields} onChange={(v) => set("requiredFields", v)} placeholder="e.g. customer, site, plant code" />
          </div>
        </Section>
        <Section title="Approval policy override" description="Tick to override the workspace policy for projects using this template.">
          <div className="px-4 py-2">
            {overrideRow("minApprovals", "Minimum approvals", "num")}
            {overrideRow("sequentialDefault", "Sequential review by default", "bool")}
            {overrideRow("requireCommentsResolved", "Require comments resolved", "bool")}
            {overrideRow("allowSelfApproval", "Allow self-approval", "bool")}
            {overrideRow("signatureRequiredForRelease", "Signatures required for release", "bool")}
            {overrideRow("requiredSignatories", "Required signatories", "num")}
          </div>
        </Section>
      </div>
      <HistoryList history={t.history} />
      <div className="sticky bottom-3 z-10 flex justify-end gap-2 rounded-lg border border-border bg-panel/95 px-4 py-2.5 shadow-float backdrop-blur">
        {dirty && <span className="mr-auto self-center text-2xs text-warning">Saving creates version {t.version + 1} (draft — needs approval)</span>}
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => setF(init)}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || busy || !f.pages.some((p) => p.trim())} onClick={save}>
          {busy ? <Spinner /> : <Save />} Save version
        </Button>
      </div>
    </div>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}
