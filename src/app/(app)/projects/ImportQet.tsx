"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Download, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { ImportDialog } from "@/library-editor/browser/ImportDialog";
import type { LibraryInfo } from "@/library-editor/types";
import { TagInput } from "@/components/volt/common";
import { downloadBlob, cn } from "@/lib/utils";
import type { CompatReport } from "@/core/model";
import { CompatReportView } from "@/components/volt/CompatReport";
import { VoltImportDialog } from "@/components/volt/VoltFile";
export { CompatReportView };
import type { FolderRow } from "./ProjectsView";
import { folderOptions } from "./NewProjectDialog";

type Parsed = { file: File; title: string; report: CompatReport; defs: number };

export function ImportQetButton({ folders, currentFolder }: { folders: FolderRow[]; currentFolder: string | null }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = React.useState(false);
  const [parsed, setParsed] = React.useState<Parsed | null>(null);
  /** a Volt project file (.volt): checked and imported on the server */
  const [volt, setVolt] = React.useState<File | null>(null);
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
    if (/\.volt$/i.test(file.name)) {
      if (input.current) input.current.value = "";
      if (file.size > 100 * 1024 * 1024) return toast.error("File exceeds the 100 MB limit");
      return void setVolt(file);
    }
    if (!/\.qet$/i.test(file.name)) return toast.error("Choose a Volt (.volt) or QElectroTech (.qet) project file");
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
      <input ref={input} type="file" accept=".volt,.qet,.elmt,.zip,application/xml" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <Button onClick={() => input.current?.click()} disabled={parsing} title="Open a Volt project file (.volt) or a QElectroTech project (.qet); element files (.elmt, .zip) go to your library">
        {parsing ? <Spinner /> : <Upload />} Import
      </Button>
      {volt && <VoltImportDialog file={volt} folders={folders} currentFolder={currentFolder} onClose={() => setVolt(null)} />}
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
