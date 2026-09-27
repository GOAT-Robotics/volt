"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { TagInput } from "@/components/volt/common";
import { api } from "@/lib/fetcher";
import { VERSION_SCHEMES } from "@/lib/constants";
import type { FolderRow, TemplateOption } from "./ProjectsView";

export function folderOptions(folders: FolderRow[]) {
  const out: { id: string; label: string }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === pid)) {
      out.push({ id: f.id, label: `${"  ".repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function NewProjectDialog({ onClose, folders, templates, currentFolder, defaultScheme }: { onClose: () => void; folders: FolderRow[]; templates: TemplateOption[]; currentFolder: string | null; defaultScheme: string }) {
  const router = useRouter();
  const def = templates.find((t) => t.isDefault);
  const [f, setF] = React.useState({ name: "", number: "", description: "", folderId: currentFolder ?? "", tags: [] as string[], versionScheme: defaultScheme || "INTEGER", customScheme: "R{n}", templateId: def?.id ?? "" });
  const [props, setProps] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const tmpl = templates.find((t) => t.id === f.templateId);
  // style templates: "" = the project template's style (or the workspace default)
  const [styles, setStyles] = React.useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [styleId, setStyleId] = React.useState("");
  React.useEffect(() => {
    api<{ templates: { id: string; name: string; isDefault: boolean }[] }>("/api/style-templates").then((j) => setStyles(j.templates)).catch(() => {});
  }, []);
  const inherited = styles.find((x) => x.id === tmpl?.styleTemplateId) ?? styles.find((x) => x.isDefault);
  // organization title block layouts: "" = the project template's layout (or the workspace default)
  const [layouts, setLayouts] = React.useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [layoutId, setLayoutId] = React.useState("");
  React.useEffect(() => {
    api<{ organization?: { id: string; name: string; isDefault: boolean }[] }>("/api/titleblocks").then((j) => setLayouts(j.organization ?? [])).catch(() => {});
  }, []);
  const inheritedLayout = layouts.find((x) => x.id === tmpl?.titleBlockLayoutId) ?? layouts.find((x) => x.isDefault);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const missing = (tmpl?.requiredFields ?? []).filter((r) => !props[r]?.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || missing.length) return;
    setBusy(true);
    try {
      const j = await api<{ id: string; versionId: string; label: string }>("/api/projects", {
        method: "POST",
        json: {
          name: f.name,
          number: f.number || undefined,
          description: f.description || undefined,
          folderId: f.folderId || null,
          tags: f.tags,
          versionScheme: f.versionScheme,
          customScheme: f.versionScheme === "CUSTOM" ? f.customScheme : null,
          templateId: f.templateId || null,
          styleTemplateId: styleId || null,
          titleBlockLayoutId: layoutId || null,
          props,
        },
      });
      toast.success(`Created ${f.name} — version ${j.label} is ready to edit`);
      router.push(`/projects/${j.id}/v/${j.versionId}`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New project" description="Creates the project with a first draft version and opens it in the editor." wide>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <Field label="Name *" className="col-span-2 sm:col-span-1">
            <Input autoFocus required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Conveyor line 3 — MCC" maxLength={200} />
          </Field>
          <Field label="Project number" className="col-span-2 sm:col-span-1">
            <Input value={f.number} onChange={(e) => set("number", e.target.value)} placeholder="e.g. GR-2026-014" maxLength={60} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Scope, site, customer…" />
          </Field>
          <Field label="Folder">
            <NativeSelect value={f.folderId} onChange={(e) => set("folderId", e.target.value)}>
              <option value="">No folder</option>
              {folderOptions(folders).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Tags">
            <TagInput value={f.tags} onChange={(v) => set("tags", v)} />
          </Field>
          <Field label="Version numbering" hint="Can be changed until the first release.">
            <NativeSelect value={f.versionScheme} onChange={(e) => set("versionScheme", e.target.value)}>
              {VERSION_SCHEMES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {f.versionScheme === "CUSTOM" ? (
            <Field label="Pattern" hint="{n} is replaced by the sequence number.">
              <Input value={f.customScheme} onChange={(e) => set("customScheme", e.target.value)} pattern=".*\{n\}.*" required />
            </Field>
          ) : (
            <div />
          )}
          <Field label="Project template" className="col-span-2" hint={tmpl?.description || (templates.length ? "Templates set page structure, title block, styles, numbering and approval rules." : "No approved project templates yet — an administrator can create them.")}>
            <NativeSelect value={f.templateId} onChange={(e) => set("templateId", e.target.value)}>
              <option value="">Blank drawing</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {layouts.length > 0 && (
            <Field label="Title block" className="col-span-2" hint="Your organization's title block layouts (Administration → Title block layouts).">
              <NativeSelect value={layoutId} onChange={(e) => setLayoutId(e.target.value)} aria-label="Title block">
                <option value="">{inheritedLayout ? `${inheritedLayout.name} (${tmpl?.titleBlockLayoutId ? "from project template" : "default"})` : "Volt's default title block"}</option>
                {layouts
                  .filter((x) => x.id !== inheritedLayout?.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          )}
          {styles.length > 0 && (
            <Field label="Drawing style" className="col-span-2" hint="Fonts, text sizes, colors and line weights. Can be changed later in the editor (Properties → Project → Drawing style).">
              <NativeSelect value={styleId} onChange={(e) => setStyleId(e.target.value)} aria-label="Drawing style">
                <option value="">{inherited ? `${inherited.name} (${tmpl?.styleTemplateId ? "from project template" : "default"})` : "Built-in defaults"}</option>
                {styles
                  .filter((x) => x.id !== inherited?.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          )}
          {tmpl && tmpl.requiredFields.length > 0 && (
            <fieldset className="col-span-2 grid grid-cols-2 gap-3 rounded-md border border-border bg-panel-2 p-3">
              <legend className="px-1 text-2xs font-medium text-muted">Required by template</legend>
              {tmpl.requiredFields.map((r) => (
                <Field key={r} label={`${r} *`}>
                  <Input required value={props[r] ?? ""} onChange={(e) => setProps((x) => ({ ...x, [r]: e.target.value }))} />
                </Field>
              ))}
            </fieldset>
          )}
          <DialogFooter className="col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !f.name.trim() || missing.length > 0}>
              {busy && <Spinner />} Create & open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
