"use client";
import { useRef, useState } from "react";
import { CheckCircle2, FileArchive, FolderOpen, Loader2, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { LibraryInfo } from "../types";

type Result = { created: number; skipped: number; updated: number; errors: string[]; ids: string[]; libraryId: string };
type Picked = { file: File; path: string };

export function ImportDialog({ open, onClose, libraries, onDone }: { open: boolean; onClose: () => void; libraries: LibraryInfo[]; onDone: (r: Result) => void }) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [target, setTarget] = useState<string>("personal");
  const [lib, setLib] = useState({ name: "", license: "", attribution: "", source: "", description: "" });
  const [dups, setDups] = useState("skip");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const add = (list: Picked[]) => {
    const ok = list.filter((f) => /\.(elmt|zip)$/i.test(f.file.name) || f.file.name === "qet_directory");
    if (list.length && !ok.length) toast.warning("Only .elmt files, folders of .elmt files and .zip archives can be imported");
    setFiles((x) => {
      const seen = new Set(x.map((f) => f.path));
      return [...x, ...ok.filter((f) => !seen.has(f.path))];
    });
    setResult(null);
  };
  const fromInput = (fl: FileList | null) => add([...(fl ?? [])].map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name })));

  const readEntry = async (entry: FileSystemEntry, prefix = ""): Promise<Picked[]> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      return [{ file, path: prefix + file.name }];
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const out: Picked[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) out.push(...(await readEntry(e, `${prefix}${entry.name}/`)));
    }
    return out;
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    if (items.length) {
      const all: Picked[] = [];
      for (const it of items) all.push(...(await readEntry(it)));
      add(all);
    } else fromInput(e.dataTransfer.files);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f.file, f.path);
      if (target === "new") {
        fd.set("newLibrary", lib.name);
        fd.set("license", lib.license);
        fd.set("attribution", lib.attribution);
        fd.set("source", lib.source);
        fd.set("description", lib.description);
      } else if (target !== "personal") fd.set("libraryId", target);
      fd.set("duplicates", dups);
      if (category.trim()) fd.set("category", category.trim());
      const res = await fetch("/api/library/import", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Import failed (${res.status})`);
      setResult(j as Result);
      onDone(j as Result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setFiles([]);
    setResult(null);
    onClose();
  };
  const writable = libraries.filter((l) => l.canWrite && !l.mine);
  const elmts = files.filter((f) => /\.elmt$/i.test(f.path)).length, zips = files.filter((f) => /\.zip$/i.test(f.path)).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent title="Import elements" description="Imported elements are private drafts until you share or publish them. Folders become categories." wide>
        {result ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat n={result.created} l="Created" tone="success" />
              <Stat n={result.updated} l="Updated" tone="accent" />
              <Stat n={result.skipped} l="Skipped (already in your library)" tone="neutral" />
            </div>
            {result.errors.length > 0 ? (
              <div className="rounded-md border border-danger/20 bg-danger-soft p-2">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-danger">
                  <XCircle className="size-3.5" /> {result.errors.length} file(s) could not be imported
                </p>
                <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-[10.5px] text-danger">
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2 className="size-3.5" /> All files were valid.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => (setResult(null), setFiles([]))}>
                Import more
              </Button>
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center", drag ? "border-accent bg-accent-soft" : "border-border-strong")}
            >
              <Upload className="size-5 text-subtle" />
              <p className="text-xs font-medium">Drop .elmt files, folders or .zip archives here</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <FileArchive /> Choose files
                </Button>
                <Button size="sm" onClick={() => dirRef.current?.click()}>
                  <FolderOpen /> Choose folder
                </Button>
              </div>
              <input ref={fileRef} type="file" multiple accept=".elmt,.zip" className="sr-only" onChange={(e) => (fromInput(e.target.files), (e.target.value = ""))} aria-label="Choose files" />
              <input
                ref={(el) => {
                  dirRef.current = el;
                  el?.setAttribute("webkitdirectory", "");
                  el?.setAttribute("directory", "");
                }}
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => (fromInput(e.target.files), (e.target.value = ""))}
                aria-label="Choose folder"
              />
            </div>
            {files.length > 0 && (
              <div className="rounded-md border border-border">
                <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5 text-2xs">
                  <span className="font-medium">
                    {elmts} element file{elmts === 1 ? "" : "s"}
                    {zips ? `, ${zips} archive${zips === 1 ? "" : "s"}` : ""}
                  </span>
                  <button className="text-subtle hover:text-danger" onClick={() => setFiles([])}>
                    Clear
                  </button>
                </div>
                <ul className="max-h-28 overflow-auto px-2.5 py-1 font-mono text-[10.5px] text-muted">
                  {files.slice(0, 200).map((f) => (
                    <li key={f.path} className="truncate">
                      {f.path}
                    </li>
                  ))}
                  {files.length > 200 && <li>… and {files.length - 200} more</li>}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Import into">
                <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="personal">My personal library</option>
                  <option value="new">A new library (keeps license & attribution)</option>
                  {writable.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="If an element already exists (same uuid)">
                <NativeSelect value={dups} onChange={(e) => setDups(e.target.value)}>
                  <option value="skip">Skip it</option>
                  <option value="update">Save as a new revision</option>
                  <option value="copy">Import as a separate copy</option>
                </NativeSelect>
              </Field>
              <Field label="Put everything under category (optional)" className="col-span-2">
                <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Vendors/Phoenix Contact" />
              </Field>
              {target === "new" && (
                <>
                  <Field label="Library name">
                    <Input value={lib.name} onChange={(e) => setLib({ ...lib, name: e.target.value })} placeholder="e.g. Siemens S7-1200 symbols" />
                  </Field>
                  <Field label="License">
                    <Input value={lib.license} onChange={(e) => setLib({ ...lib, license: e.target.value })} placeholder="e.g. CC-BY 3.0" />
                  </Field>
                  <Field label="Attribution">
                    <Input value={lib.attribution} onChange={(e) => setLib({ ...lib, attribution: e.target.value })} placeholder="Author / copyright holder" />
                  </Field>
                  <Field label="Source">
                    <Input value={lib.source} onChange={(e) => setLib({ ...lib, source: e.target.value })} placeholder="URL or where it came from" />
                  </Field>
                  <Field label="Description" className="col-span-2">
                    <Textarea rows={2} value={lib.description} onChange={(e) => setLib({ ...lib, description: e.target.value })} />
                  </Field>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || !files.length || (target === "new" && !lib.name.trim())} onClick={submit}>
                {busy ? <Loader2 className="animate-spin" /> : <Upload />} Import
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ n, l, tone }: { n: number; l: string; tone: "success" | "accent" | "neutral" }) {
  return (
    <div className={cn("rounded-lg border p-2.5", tone === "success" ? "border-success/20 bg-success-soft text-success" : tone === "accent" ? "border-accent/20 bg-accent-soft text-accent" : "border-border bg-panel-2 text-muted")}>
      <p className="text-lg font-semibold tabular">{n}</p>
      <p className="text-2xs">{l}</p>
    </div>
  );
}
