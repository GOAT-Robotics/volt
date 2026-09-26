"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Building2, Download, ExternalLink, Library, Loader2, Lock, Pencil, Plus, ThumbsDown, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Empty, Spinner, Switch, Table } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { relTime } from "@/lib/utils";
import type { LibItem, LibraryInfo } from "../types";
import { ConfirmDialog, PreviewImg, PromptDialog, categoryTrail } from "../shared/common";

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export function ApprovalsTab({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [reject, setReject] = useState<LibItem | null>(null);
  const load = () =>
    api<{ items: LibItem[] }>("/api/library/elements?scope=pending&limit=500")
      .then((j) => setItems(j.items))
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    load();
  }, []);
  const act = async (it: LibItem, action: "approve" | "reject", reason?: string) => {
    try {
      await api(`/api/library/elements/${it.id}/workflow`, { method: "POST", json: { action, reason } });
      toast.success(action === "approve" ? `Approved “${it.name}”` : `Sent “${it.name}” back to the author`);
      load();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!items)
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  if (!items.length)
    return (
      <Empty icon={<BadgeCheck />} title="Nothing to approve">
        Elements submitted for organization-wide use appear here.
      </Empty>
    );
  return (
    <div className="p-6">
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <Table>
          <thead>
            <tr>
              <th className="w-20">Symbol</th>
              <th>Element</th>
              <th>Submitted by</th>
              <th>Revision</th>
              <th>Updated</th>
              <th className="text-right">Decision</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  <div className="flex h-12 w-16 items-center justify-center rounded bg-white p-1 dark:bg-panel-2">
                    <PreviewImg id={it.id} rev={it.revision} className="max-h-10 max-w-14" />
                  </div>
                </td>
                <td>
                  <Link href={`/library/${it.id}`} className="font-medium hover:underline">
                    {it.name}
                  </Link>
                  <p className="text-2xs text-subtle">
                    {categoryTrail(it.category)} {it.kind === "BLOCK" && "· block"}
                  </p>
                </td>
                <td className="text-muted">{it.ownerName ?? "—"}</td>
                <td className="tabular">{it.revision}</td>
                <td className="text-muted">{it.updatedAt ? relTime(it.updatedAt) : "—"}</td>
                <td>
                  <div className="flex justify-end gap-1.5">
                    <Button size="xs" asChild variant="ghost">
                      <Link href={`/library/${it.id}`}>
                        <ExternalLink /> Review
                      </Link>
                    </Button>
                    <Button size="xs" onClick={() => setReject(it)}>
                      <ThumbsDown /> Reject
                    </Button>
                    <Button size="xs" variant="primary" onClick={() => act(it, "approve")}>
                      <BadgeCheck /> Approve
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <PromptDialog
        open={!!reject}
        title={`Reject “${reject?.name}”`}
        description="The author gets your reason and the element returns to draft."
        label="What needs to change?"
        required
        danger
        confirm="Reject"
        onClose={() => setReject(null)}
        onSubmit={async (v) => {
          if (reject) await act(reject, "reject", v);
          setReject(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Libraries                                                           */
/* ------------------------------------------------------------------ */

const SCOPE_ICON: Record<string, React.ReactNode> = { PERSONAL: <Lock />, SHARED: <Users />, ORG: <Building2 /> };
const SCOPE_LABEL: Record<string, string> = { PERSONAL: "Personal", SHARED: "Shared", ORG: "Organization" };

export function LibrariesTab({ libraries, canCreateOrg, reload, onBrowse }: { libraries: LibraryInfo[] | null; canCreateOrg: boolean; reload: () => void; onBrowse: (id: string) => void }) {
  const [edit, setEdit] = useState<LibraryInfo | "new" | null>(null);
  const [del, setDel] = useState<LibraryInfo | null>(null);
  if (!libraries)
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-3 p-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">Libraries group elements and carry their license and attribution. Imported collections keep where they came from.</p>
        <Button size="sm" onClick={() => setEdit("new")}>
          <Plus /> New library
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <Table>
          <thead>
            <tr>
              <th>Library</th>
              <th>Scope</th>
              <th className="text-right">Elements</th>
              <th>License</th>
              <th>Attribution / source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {libraries.map((l) => (
              <tr key={l.id}>
                <td>
                  <button className="text-left font-medium hover:underline" onClick={() => onBrowse(l.id)}>
                    {l.name}
                  </button>
                  {l.description && <p className="max-w-sm truncate text-2xs text-subtle">{l.description}</p>}
                </td>
                <td>
                  <span className="inline-flex items-center gap-1 text-muted [&_svg]:size-3">
                    {SCOPE_ICON[l.scope]} {SCOPE_LABEL[l.scope] ?? l.scope}
                  </span>
                  {l.ownerName && <p className="text-2xs text-subtle">{l.ownerName}</p>}
                </td>
                <td className="text-right tabular">{l.count}</td>
                <td className="max-w-40 truncate text-muted">{l.license ?? "—"}</td>
                <td className="max-w-64">
                  <p className="truncate text-muted">{l.attribution ?? "—"}</p>
                  {l.source && (
                    <p className="truncate text-2xs text-subtle">
                      {/^https?:\/\//.test(l.source) ? (
                        <a href={l.source} target="_blank" rel="noreferrer noopener" className="hover:underline">
                          {l.source}
                        </a>
                      ) : (
                        l.source
                      )}
                    </p>
                  )}
                </td>
                <td>
                  <div className="flex justify-end gap-0.5">
                    <Button size="icon-sm" variant="ghost" aria-label={`Export ${l.name} as zip`} title="Export as .zip" disabled={!l.count} onClick={() => (location.href = `/api/library/export?libraryId=${l.id}`)}>
                      <Download />
                    </Button>
                    {l.canManage && (
                      <>
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => setEdit(l)}>
                          <Pencil />
                        </Button>
                        {!l.mine && (
                          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${l.name}`} className="hover:text-danger" onClick={() => setDel(l)}>
                            <Trash2 />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {edit && <LibraryDialog lib={edit === "new" ? null : edit} canCreateOrg={canCreateOrg} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
      <ConfirmDialog
        open={!!del}
        danger
        title={`Delete library “${del?.name}”?`}
        description={del?.count ? `It contains ${del.count} element(s) you can see — they will be deleted with it, including their history.` : "The library is empty."}
        confirm="Delete library"
        onClose={() => setDel(null)}
        onConfirm={async () => {
          try {
            await api(`/api/library/libraries/${del!.id}?force=1`, { method: "DELETE" });
            toast.success("Library deleted");
            setDel(null);
            reload();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </div>
  );
}

function LibraryDialog({ lib, canCreateOrg, onClose, onSaved }: { lib: LibraryInfo | null; canCreateOrg: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: lib?.name ?? "", description: lib?.description ?? "", scope: lib?.scope ?? "PERSONAL", license: lib?.license ?? "", attribution: lib?.attribution ?? "", source: lib?.source ?? "" });
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const json = { ...f, license: f.license || null, attribution: f.attribution || null, source: f.source || null };
      if (lib) await api(`/api/library/libraries/${lib.id}`, { method: "PATCH", json: { ...json, applyToElements: apply } });
      else await api("/api/library/libraries", { method: "POST", json });
      toast.success(lib ? "Library updated" : "Library created");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={lib ? `Edit “${lib.name}”` : "New library"} wide>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" className="col-span-2">
            <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="Scope" hint="Element visibility is set per element; the scope says who may add to the library.">
            <NativeSelect value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
              <option value="PERSONAL">Personal</option>
              <option value="SHARED">Shared</option>
              <option value="ORG" disabled={!canCreateOrg && lib?.scope !== "ORG"}>
                Organization
              </option>
            </NativeSelect>
          </Field>
          <Field label="License">
            <Input value={f.license} onChange={(e) => setF({ ...f, license: e.target.value })} placeholder="e.g. CC-BY 3.0, proprietary" />
          </Field>
          <Field label="Attribution">
            <Input value={f.attribution} onChange={(e) => setF({ ...f, attribution: e.target.value })} />
          </Field>
          <Field label="Source">
            <Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="URL" />
          </Field>
          {lib && (
            <label className="col-span-2 flex items-center gap-2 text-xs">
              <Switch checked={apply} onCheckedChange={setApply} /> Also apply license and attribution to all elements in this library
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !f.name.trim()} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <Library />} {lib ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { Badge };
