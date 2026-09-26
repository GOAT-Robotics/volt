"use client";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Checkbox, Switch, TabsRoot, TabsList, TabsTrigger, TabsContent, Badge } from "@/components/ui/misc";
import { planRenumber, duplicateRefs } from "@/core/numbering";
import type { NumberingRule } from "@/core/model";
import { uid } from "@/core/ids";

export function NumberingDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [rules, setRules] = useState<NumberingRule[]>(doc.numbering.rules);
  const [auto, setAuto] = useState(doc.numbering.autoOnPlace);
  const [scope, setScope] = useState<"page" | "all">("all");
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const previewDoc = useMemo(() => ({ ...doc, numbering: { rules, autoOnPlace: auto } }), [doc, rules, auto]);
  const changes = useMemo(() => planRenumber(previewDoc, scope === "all" ? "all" : [pageId], onlyEmpty), [previewDoc, scope, pageId, onlyEmpty]);
  const dupes = useMemo(() => duplicateRefs(doc), [doc]);
  const prefixes = useMemo(() => [...new Set(Object.values(doc.defs).map((d) => d.prefix).filter(Boolean))].sort(), [doc.defs]);
  const locked = useMemo(() => doc.pages.reduce((a, p) => a + p.elements.filter((e) => e.refLocked).length, 0), [doc.pages]);
  const upd = (i: number, p: Partial<NumberingRule>) => setRules((r) => r.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const byId = useMemo(() => {
    const m = new Map<string, { page: string; name: string }>();
    for (const p of doc.pages) for (const e of p.elements) m.set(e.id, { page: p.title, name: doc.defs[e.defId]?.name ?? "" });
    return m;
  }, [doc]);

  const saveRules = () =>
    useEditor.getState().apply("Numbering rules", (d) => {
      d.numbering = { rules, autoOnPlace: auto };
    });
  const apply = () => {
    const ch = changes;
    useEditor.getState().apply(`Renumber ${ch.length} reference${ch.length === 1 ? "" : "s"}`, (d) => {
      d.numbering = { rules, autoOnPlace: auto };
      for (const c of ch) {
        const e = d.pages.find((p) => p.id === c.pageId)?.elements.find((x) => x.id === c.elId);
        if (e) e.info.label = c.to;
      }
    });
    ui.toast(`Renumbered ${ch.length} reference${ch.length === 1 ? "" : "s"}`, { undo: true });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Automatic numbering" description="Rules decide reference designators for new and renumbered components. Locked references are never changed." wide="xl">
        <TabsRoot defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="renumber">Renumber {changes.length > 0 && <Badge tone="accent" className="ml-1">{changes.length}</Badge>}</TabsTrigger>
            <TabsTrigger value="issues">Duplicates {dupes.size > 0 && <Badge tone="danger" className="ml-1">{dupes.size}</Badge>}</TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="pt-3">
            <label className="mb-3 flex items-center gap-2 text-xs">
              <Switch checked={auto} disabled={!editable} onCheckedChange={setAuto} /> Number components automatically when placed
            </label>
            <table className="w-full text-xs">
              <thead className="text-2xs text-subtle">
                <tr>
                  <th className="py-1 text-left font-medium">Applies to (prefix / category, * = any)</th>
                  <th className="text-left font-medium">Prefix</th>
                  <th className="text-left font-medium">Scope</th>
                  <th className="text-left font-medium">Format</th>
                  <th className="text-left font-medium">Start</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={r.id}>
                    <td className="py-0.5 pr-1">
                      <Input value={r.match} disabled={!editable} list="volt-prefixes" onChange={(e) => upd(i, { match: e.target.value })} />
                    </td>
                    <td className="pr-1">
                      <Input value={r.prefix} disabled={!editable} placeholder="(element prefix)" onChange={(e) => upd(i, { prefix: e.target.value })} />
                    </td>
                    <td className="pr-1">
                      <NativeSelect value={r.scope} disabled={!editable} onChange={(e) => upd(i, { scope: e.target.value as NumberingRule["scope"] })}>
                        <option value="project">Project</option>
                        <option value="page">Page</option>
                        <option value="location">Location / cabinet</option>
                      </NativeSelect>
                    </td>
                    <td className="pr-1">
                      <Input value={r.format} disabled={!editable} className="font-mono" onChange={(e) => upd(i, { format: e.target.value })} />
                    </td>
                    <td className="w-16 pr-1">
                      <Input type="number" value={r.start} disabled={!editable} onChange={(e) => upd(i, { start: Number(e.target.value) || 1 })} />
                    </td>
                    <td>
                      <Button variant="ghost" size="icon-sm" disabled={!editable || r.match === "*"} onClick={() => setRules((x) => x.filter((_, k) => k !== i))} aria-label="Remove rule">
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="volt-prefixes">
              {prefixes.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <div className="mt-2 flex items-center gap-2">
              <Button size="xs" variant="secondary" disabled={!editable} onClick={() => setRules((r) => [{ id: uid(), match: prefixes[0] ?? "K", prefix: "", scope: "project", format: "{prefix}{n}", start: 1 }, ...r])}>
                <Plus /> Add rule
              </Button>
              <span className="text-2xs text-subtle">Tokens: {"{prefix} {n} {n:3} {page} {location}"} — e.g. {"{page}{prefix}{n:2}"} → 3K01</span>
            </div>
          </TabsContent>
          <TabsContent value="renumber" className="pt-3">
            <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
              <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as "page" | "all")} className="w-44">
                <option value="all">Entire project</option>
                <option value="page">Current page only</option>
              </NativeSelect>
              <label className="flex items-center gap-2">
                <Checkbox checked={onlyEmpty} onCheckedChange={(v) => setOnlyEmpty(!!v)} /> Only components without a reference
              </label>
              <span className="text-2xs text-subtle">{locked} locked reference{locked === 1 ? "" : "s"} kept</span>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-panel-2 text-2xs text-subtle">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Page</th>
                    <th className="text-left font-medium">Component</th>
                    <th className="text-left font-medium">From</th>
                    <th className="text-left font-medium">To</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.slice(0, 1000).map((c) => (
                    <tr key={c.elId} className="border-t border-border">
                      <td className="px-3 py-1">{byId.get(c.elId)?.page}</td>
                      <td className="text-muted">{byId.get(c.elId)?.name}</td>
                      <td className="font-mono text-danger line-through">{c.from || "∅"}</td>
                      <td className="font-mono text-success">{c.to}</td>
                    </tr>
                  ))}
                  {!changes.length && (
                    <tr>
                      <td colSpan={4} className="p-6 text-center text-subtle">
                        Everything is already numbered according to the rules.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>
          <TabsContent value="issues" className="pt-3">
            {!dupes.size ? (
              <p className="p-6 text-center text-xs text-subtle">No duplicate references.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {[...dupes.entries()].map(([ref, occ]) => (
                  <li key={ref} className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-danger">{ref}</span>
                    <span className="text-muted">× {occ.length} — {occ.map((o) => byId.get(o.elId)?.page).join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </TabsRoot>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!editable} onClick={() => (saveRules(), onClose())}>
            Save rules
          </Button>
          <Button variant="primary" disabled={!editable || !changes.length} onClick={apply}>
            Apply {changes.length} change{changes.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
