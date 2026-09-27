"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Download, CheckCircle2, AlertTriangle, Archive, XCircle, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { ImportDialog } from "@/library-editor/browser/ImportDialog";
import type { LibraryInfo } from "@/library-editor/types";
import { TagInput } from "@/components/volt/common";
import { downloadBlob, cn } from "@/lib/utils";
import type { CompatItem, CompatLevel, CompatReport } from "@/core/model";
import type { FolderRow } from "./ProjectsView";
import { folderOptions } from "./NewProjectDialog";

type Parsed = { file: File; title: string; report: CompatReport; defs: number };

export function ImportQetButton({ folders, currentFolder }: { folders: FolderRow[]; currentFolder: string | null }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = React.useState(false);
  const [parsed, setParsed] = React.useState<Parsed | null>(null);
  /** an element (.elmt) or a .zip of them goes to the library, through the import review */
  const [elements, setElements] = React.useState<File[] | null>(null);
  const [libs, setLibs] = React.useState<LibraryInfo[]>([]);
  const importElements = (file: File) => {
    void fetch("/api/library/libraries")
      .then((r) => (r.ok ? r.json() : { libraries: [] }))
      .then((j: { libraries: LibraryInfo[] }) => setLibs(j.libraries))
      .catch(() => {});
    setElements([file]);
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (/\.(elmt|zip)$/i.test(file.name)) {
      if (input.current) input.current.value = "";
      return void importElements(file);
    }
    if (!/\.qet$/i.test(file.name)) return toast.error("Choose a project file (.qet)");
    if (file.size > 50 * 1024 * 1024) return toast.error("File exceeds the 50 MB limit");
    setParsing(true);
    try {
      const xml = await file.text();
      const { importQet } = await import("@/core/qet");
      const { doc, report } = importQet(xml, file.name);
      setParsed({ file, title: doc.meta.title || file.name.replace(/\.qet$/i, ""), report, defs: Object.keys(doc.defs).length });
    } catch (e) {
      toast.error(`Could not read ${file.name}: ${(e as Error).message}`);
    } finally {
      setParsing(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input ref={input} type="file" accept=".qet,.elmt,.zip,application/xml" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <Button onClick={() => input.current?.click()} disabled={parsing}>
        {parsing ? <Spinner /> : <Upload />} Import .qet
      </Button>
      <ImportDialog
        open={!!elements}
        initialFiles={elements}
        libraries={libs}
        onClose={() => setElements(null)}
        onDone={(r) => {
          if (r.created || r.updated) toast.success("Added to your personal library — find it under Library → Mine or in the editor's library panel");
        }}
      />
      {parsed && <ImportPreview parsed={parsed} folders={folders} currentFolder={currentFolder} onClose={() => setParsed(null)} />}
    </>
  );
}

const LEVELS: { level: CompatLevel; label: string; icon: React.ReactNode; cls: string; help: string }[] = [
  { level: "supported", label: "Supported", icon: <CheckCircle2 />, cls: "text-success", help: "Imported and fully editable." },
  { level: "degraded", label: "Degraded", icon: <AlertTriangle />, cls: "text-warning", help: "Imported with simplifications — check these areas." },
  { level: "preserved", label: "Preserved", icon: <Archive />, cls: "text-accent", help: "Not editable in Volt, kept byte-for-byte and written back on .qet export." },
  { level: "unsupported", label: "Unsupported", icon: <XCircle />, cls: "text-danger", help: "Not represented; still kept in the stored original file." },
];

export function CompatReportView({ report }: { report: CompatReport }) {
  const groups = LEVELS.map((l) => ({ ...l, items: report.items.filter((i) => i.level === l.level) }));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        {groups.map((g) => (
          <div key={g.level} className="rounded-md border border-border bg-panel-2 px-2.5 py-2">
            <p className={cn("flex items-center gap-1 text-2xs font-medium [&_svg]:size-3", g.cls)}>
              {g.icon} {g.label}
            </p>
            <p className="text-base font-semibold tabular-nums">{g.items.length}</p>
          </div>
        ))}
      </div>
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <details key={g.level} open={g.level !== "supported"} className="rounded-md border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs font-medium">
              <span className={cn("[&_svg]:size-3.5", g.cls)}>{g.icon}</span>
              {g.label} <span className="text-muted">— {g.help}</span>
            </summary>
            <ul className="border-t border-border px-3 py-1.5">
              {g.items.map((i: CompatItem, k) => (
                <li key={k} className="flex gap-2 py-0.5 text-2xs">
                  <span className="w-28 shrink-0 font-medium text-muted">{i.area}</span>
                  <span className="flex-1">{i.message}</span>
                  {i.count !== undefined && <span className="tabular-nums text-muted">×{i.count}</span>}
                  {i.page && <span className="text-muted">{i.page}</span>}
                </li>
              ))}
            </ul>
          </details>
        ))}
    </div>
  );
}

function ImportPreview({ parsed, folders, currentFolder, onClose }: { parsed: Parsed; folders: FolderRow[]; currentFolder: string | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(parsed.title);
  const [number, setNumber] = React.useState("");
  const [folderId, setFolderId] = React.useState(currentFolder ?? "");
  const [tags, setTags] = React.useState<string[]>(["imported"]);
  const [busy, setBusy] = React.useState(false);
  const r = parsed.report;
  const confirm = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", parsed.file);
      fd.append("name", name);
      if (number) fd.append("number", number);
      if (folderId) fd.append("folderId", folderId);
      fd.append("tags", JSON.stringify(tags));
      const res = await fetch("/api/projects/import", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Import failed (${res.status})`);
      toast.success(`Imported ${parsed.file.name}`);
      router.push(`/projects/${j.id}/v/${j.versionId}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title="Import project" description={`${parsed.file.name} · ${(parsed.file.size / 1024).toFixed(0)} KB · format ${r.qetVersion || "unknown"}`} wide="xl">
        <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-panel-2 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <FileText className="size-3.5 text-muted" /> {parsed.title}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                <dt className="text-muted">Pages</dt>
                <dd className="font-medium tabular-nums">{r.pageCount}</dd>
                <dt className="text-muted">Components</dt>
                <dd className="font-medium tabular-nums">{r.elementCount}</dd>
                <dt className="text-muted">Wires</dt>
                <dd className="font-medium tabular-nums">{r.wireCount}</dd>
                <dt className="text-muted">Element definitions</dt>
                <dd className="font-medium tabular-nums">{r.definitionCount || parsed.defs}</dd>
              </dl>
            </div>
            <Field label="Project name *">
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            </Field>
            <Field label="Project number">
              <Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Folder">
              <NativeSelect value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">No folder</option>
                {folderOptions(folders).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Tags">
              <TagInput value={tags} onChange={setTags} />
            </Field>
            <p className="text-2xs text-muted">The original file is stored unchanged with its SHA-256, and the server re-checks it before creating version 1.</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold">Compatibility report</p>
            <CompatReportView report={r} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="mr-auto" onClick={() => downloadBlob(new Blob([JSON.stringify({ file: parsed.file.name, report: r }, null, 2)], { type: "application/json" }), parsed.file.name.replace(/\.qet$/i, "") + "-compatibility.json")}>
            <Download /> Download report
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Upload />} Import & open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
