"use client";
import { useMemo, useState } from "react";
import { Loader2, Boxes, Building2, Lock, Users } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Field, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { buildBlock, mergeToDef } from "@/core/blocks";
import { serializeElmt } from "@/core/qet/elmt";
import { getPage } from "@/core/ops";
import { uid } from "@/core/ids";
import { cn } from "@/lib/utils";

export function VisibilityPicker({ value, onChange }: { value: "PRIVATE" | "ORG"; onChange: (v: "PRIVATE" | "ORG") => void }) {
  const opts = [
    { id: "PRIVATE" as const, icon: <Lock />, label: "Only me", desc: "Personal draft. Share later." },
    { id: "ORG" as const, icon: <Building2 />, label: "Organization", desc: "Everyone in the workspace can find and reuse it." },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {opts.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} className={cn("rounded-lg border p-2.5 text-left [&_svg]:size-3.5", value === o.id ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")} aria-pressed={value === o.id}>
          <p className="flex items-center gap-1.5 text-xs font-medium">
            {o.icon}
            {o.label}
          </p>
          <p className="mt-0.5 text-2xs text-muted">{o.desc}</p>
        </button>
      ))}
    </div>
  );
}

export function BlockDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const page = useEditor((s) => s.page());
  const sel = useEditor((s) => s.sel);
  const ui = useEditorUI();
  const built = useMemo(() => buildBlock(doc, page, sel), [doc, page, sel]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Blocks");
  const [visibility, setVisibility] = useState<"PRIVATE" | "ORG">("ORG");
  const [ports, setPorts] = useState(built.ports.map((p) => p.name));
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const content = { ...built.content, ports: built.content.ports.map((p, i) => ({ ...p, name: ports[i] || p.name })) };
      const j = await api<{ id: string; revision: number }>("/api/library/blocks", { method: "POST", json: { name, description, category, visibility, content } });
      if (replace) {
        const gid = uid();
        const s = useEditor.getState();
        const els = new Set(sel.elements), ws = new Set(sel.wires), js = new Set(sel.junctions);
        const srcIndex = new Map<string, string>();
        built.content.elements.forEach((e) => srcIndex.set(e.id, e.id));
        s.apply(`Link selection to block ${name}`, (d) => {
          const p = getPage(d, page.id);
          const origin = { x: Math.min(...p.elements.filter((e) => els.has(e.id)).map((e) => e.x)), y: 0 };
          void origin;
          for (const e of p.elements) if (els.has(e.id)) e.group = { id: gid, blockId: j.id, revision: j.revision, mode: "linked", name, src: e.id, origin: blockOrigin(built) };
          for (const w of p.wires) if (ws.has(w.id)) w.group = { id: gid, blockId: j.id, revision: j.revision, mode: "linked", name, src: w.id, origin: blockOrigin(built) };
          for (const x of p.junctions) if (js.has(x.id)) x.group = { id: gid, blockId: j.id, revision: j.revision, mode: "linked", name, src: x.id, origin: blockOrigin(built) };
        });
      }
      ui.toast(`Block “${name}” saved to the ${visibility === "ORG" ? "organization" : "personal"} library`);
      onClose();
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Create reusable block" description={`${built.content.elements.length} components, ${built.content.wires.length} wires. Named connection points become the block’s ports.`} wide>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DOL motor starter" />
          </Field>
          <Field label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <div className="col-span-2">
            <p className="mb-1 text-2xs font-medium text-muted">External connection points ({ports.length})</p>
            <div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto">
              {ports.map((p, i) => (
                <Input key={i} value={p} onChange={(e) => setPorts(ports.map((x, k) => (k === i ? e.target.value : x)))} />
              ))}
              {!ports.length && <p className="text-2xs text-subtle">No external connections — the block is self-contained.</p>}
            </div>
          </div>
          <div className="col-span-2">
            <p className="mb-1 text-2xs font-medium text-muted">Who can use it</p>
            <VisibilityPicker value={visibility} onChange={setVisibility} />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs">
            <Switch checked={replace} onCheckedChange={setReplace} /> Link the selection to the new block (updates can propagate)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <Boxes />} Save block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function blockOrigin(b: ReturnType<typeof buildBlock>) {
  // content coordinates are relative to this origin: recover it from first element
  const e = b.content.elements[0];
  const page = useEditor.getState().page();
  const orig = page.elements.find((x) => x.id === e?.id);
  return orig && e ? { x: orig.x - e.x, y: orig.y - e.y } : { x: 0, y: 0 };
}

export function CreateElementDialog({ onClose, arg }: { onClose: () => void; arg?: { fromDef?: string } }) {
  const doc = useEditor((s) => s.doc);
  const page = useEditor((s) => s.page());
  const sel = useEditor((s) => s.sel);
  const ui = useEditorUI();
  const src = arg?.fromDef ? doc.defs[arg.fromDef] : null;
  const [name, setName] = useState(src ? src.names.en ?? src.name : "");
  const [category, setCategory] = useState(src?.category || "Custom");
  const [prefix, setPrefix] = useState(src?.prefix ?? "");
  const [visibility, setVisibility] = useState<"PRIVATE" | "ORG">("PRIVATE");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      let def = src ? { ...src, source: undefined } : mergeToDef(doc, page, sel.elements, name);
      def = { ...def, name, names: { ...def.names, en: name }, prefix, category };
      if (!src) {
        const right = def.width - def.hotspotX + 2, top = -def.hotspotY;
        def.prims = [...def.prims, { t: "dyntext", x: right, y: top, from: "ElementInfo", info: "label", text: "", size: 9, rotation: 0, halign: "left", valign: "top", frame: false, width: -1, uuid: uid() }];
        def.info = { label: "" };
      }
      const content = serializeElmt({ ...def, xml: src?.xml });
      const j = await api<{ id: string }>("/api/library/elements", { method: "POST", json: { name, category, prefix, visibility, content, description: "" } });
      ui.toast("Element created — opening the element editor");
      window.open(`/library/${j.id}`, "_blank");
      onClose();
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={src ? "Save element to library" : "Create element from selection"} description={src ? "Adds this definition to the shared library so others can reuse it." : `Merges ${sel.elements.length} component symbol(s) into one new element; all pins are kept.`}>
        <div className="space-y-3">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} />
            </Field>
            <Field label="Reference prefix">
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. K, Q, M" />
            </Field>
          </div>
          <VisibilityPicker value={visibility} onChange={setVisibility} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={create}>
            {busy && <Loader2 className="animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { Users, NativeSelect };
