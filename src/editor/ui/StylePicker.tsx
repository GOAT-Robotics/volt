"use client";
/** Choose the style template a project is based on (its project-level overrides stay on top). */
import { useEffect, useState } from "react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { NativeSelect } from "@/components/ui/input";
import type { Styles } from "@/core/model";

type Opt = { id: string; name: string; version: number; isDefault: boolean };
let cache: Promise<Opt[]> | null = null;

export function StylePicker({ className }: { className?: string }) {
  const ref = useEditor((s) => s.doc.baseStylesRef);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [opts, setOpts] = useState<Opt[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    cache ??= fetch("/api/style-templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((j: { templates: Opt[] }) => j.templates)
      .catch(() => []);
    let live = true;
    void cache.then((o) => live && setOpts(o));
    return () => {
      live = false;
    };
  }, []);
  const choose = async (id: string, force = false) => {
    if (!id || (id === ref?.templateId && !force)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/style-templates/${id}`);
      const j = (await r.json()) as { id: string; name: string; version: number; styles: Styles; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Could not load the style template");
      useEditor.getState().apply(`Style: ${j.name}`, (d) => {
        d.baseStyles = j.styles;
        d.baseStylesRef = { templateId: j.id, version: j.version, name: j.name };
      });
      ui.toast(`Drawing style changed to “${j.name}”${Object.keys(useEditor.getState().doc.styles ?? {}).length ? " — project overrides kept" : ""}`, { undo: true });
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const current = opts.find((o) => o.id === ref?.templateId);
  const outdated = current && ref && current.version > ref.version;
  return (
    <div className={className}>
      <NativeSelect value={ref?.templateId ?? ""} disabled={!editable || busy || !opts.length} onChange={(e) => void choose(e.target.value)} aria-label="Drawing style">
        {!ref?.templateId && <option value="">Built-in defaults</option>}
        {ref?.templateId && !current && <option value={ref.templateId}>{ref.name} (retired)</option>}
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.isDefault ? " (default)" : ""}
          </option>
        ))}
      </NativeSelect>
      {outdated && editable && (
        <button className="mt-1 text-2xs text-accent hover:underline" onClick={() => void choose(current.id, true)}>
          Update to v{current.version} (project uses v{ref!.version})
        </button>
      )}
    </div>
  );
}
