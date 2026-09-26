"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import type { BlockContent } from "@/core/model";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader, Spinner, Table, Badge } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import type { ElementDetail, LibUser } from "./types";
import { WorkflowBar } from "./shared/WorkflowBar";
import { RevisionsPanel } from "./shared/RevisionsPanel";
import { PreviewImg } from "./shared/common";

export function BlockDetail({ id, user }: { id: string; user: LibUser }) {
  const [d, setD] = useState<ElementDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", category: "", tags: "" });
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(0);
  const load = useCallback(async () => {
    try {
      const j = await api<ElementDetail>(`/api/library/elements/${id}`);
      setD(j);
      setForm({ name: j.name, description: j.description, category: j.category, tags: j.tags.join(", ") });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  const content = useMemo<BlockContent | null>(() => {
    try {
      return d ? (JSON.parse(d.content) as BlockContent) : null;
    } catch {
      return null;
    }
  }, [d]);
  if (err) return <p className="p-10 text-center text-sm text-muted">{err}</p>;
  if (!d)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const dirty = form.name !== d.name || form.description !== d.description || form.category !== d.category || form.tags !== d.tags.join(", ");
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/library/blocks/${d.id}`, {
        method: "PUT",
        json: { name: form.name, description: form.description, category: form.category, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) },
      });
      toast.success("Block details saved");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const comps = content ? content.elements.map((e) => ({ label: e.info.label ?? "", def: content.defs[e.defId] })) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkflowBar d={d} user={user} dirty={dirty} reload={() => (load(), setK((x) => x + 1))} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Preview" description={`Block · revision ${d.revision}. Place it from the diagram editor’s library panel; editing happens in a drawing.`} />
              <div className="flex min-h-72 items-center justify-center bg-white p-6 dark:bg-panel-2">
                <PreviewImg id={d.id} rev={d.revision} className="max-h-[480px] w-full" alt={d.name} />
              </div>
            </Card>
            <Card>
              <CardHeader title={`Ports (${content?.ports.length ?? 0})`} description="External connection points of the block" />
              {content?.ports.length ? (
                <Table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Component pin</th>
                      <th className="text-right">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.ports.map((p, i) => {
                      const el = content.elements.find((e) => e.id === p.el);
                      const pin = el ? content.defs[el.defId]?.pins.find((x) => x.id === p.pin) : undefined;
                      return (
                        <tr key={i}>
                          <td className="font-medium">{p.name}</td>
                          <td className="text-muted">{el ? `${el.info.label || "?"}:${pin?.number || pin?.name || "?"}` : "—"}</td>
                          <td className="text-right tabular text-subtle">
                            {Math.round(p.x)}, {Math.round(p.y)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              ) : (
                <p className="px-4 py-3 text-2xs text-subtle">Self-contained — no external ports.</p>
              )}
            </Card>
            <Card>
              <CardHeader title="Contents" description={content ? `${content.elements.length} components · ${content.wires.length} wires · ${Object.keys(content.defs).length} symbol definitions` : "Unreadable content"} />
              <div className="flex flex-wrap gap-1.5 px-4 py-3">
                {comps.map((c, i) => (
                  <Badge key={i}>
                    {c.label || "—"} {c.def ? `· ${c.def.names.en ?? c.def.name}` : ""}
                  </Badge>
                ))}
              </div>
            </Card>
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader title="Details" />
              <div className="space-y-3 p-4">
                <Field label="Name">
                  <Input value={form.name} disabled={!d.access.canEdit} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="Category">
                  <Input value={form.category} disabled={!d.access.canEdit} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                </Field>
                <Field label="Description">
                  <Textarea rows={3} value={form.description} disabled={!d.access.canEdit} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </Field>
                <Field label="Tags" hint="Comma separated">
                  <Input value={form.tags} disabled={!d.access.canEdit} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
                </Field>
                {d.access.canEdit && (
                  <Button variant="primary" disabled={!dirty || busy || !form.name.trim()} onClick={save}>
                    {busy ? <Loader2 className="animate-spin" /> : <Save />} Save details
                  </Button>
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="History" />
              <RevisionsPanel id={d.id} current={d.revision} approved={d.approvedRevision} canRestore={d.access.canEdit} refreshKey={k} onRestored={load} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
