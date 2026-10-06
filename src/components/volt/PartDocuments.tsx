"use client";
/**
 * Datasheets / spec sheets of a part — on a library element (shared, every placed copy shows it)
 * or on one placed component. Upload a file or paste a link; open in a new tab.
 */
import * as React from "react";
import { FileText, Link2, Upload, Trash2, Search, ExternalLink, BookOpen, ShieldCheck, Ruler, Box, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

export type PartDoc = { id: string; scope: string; origin: "component" | "library" | "part"; kind: string; title: string; url: string | null; filename: string | null; mime: string | null; size: number | null; href: string; createdBy: string; createdAt: string; partNumber: string | null; manufacturer: string | null };

export const KIND_LABEL: Record<string, string> = { DATASHEET: "Datasheet", SPEC: "Spec sheet", MANUAL: "Manual", CERTIFICATE: "Certificate", DRAWING: "Drawing", CAD: "CAD model", OTHER: "Other" };
const ICON: Record<string, React.ReactNode> = { DATASHEET: <FileText />, SPEC: <FileText />, MANUAL: <BookOpen />, CERTIFICATE: <ShieldCheck />, DRAWING: <Ruler />, CAD: <Box />, OTHER: <FileIcon /> };
const ORIGIN: Record<PartDoc["origin"], string> = { component: "", library: "library", part: "same part no." };

export function PartDocuments({
  target,
  partNumber,
  manufacturer,
  compact,
  onError,
}: {
  /** where documents are listed and added */
  target: { scope: "COMPONENT"; projectId: string; elementId: string; libraryElementId?: string | null } | { scope: "LIBRARY"; libraryElementId: string };
  partNumber?: string;
  manufacturer?: string;
  compact?: boolean;
  onError?: (msg: string) => void;
}) {
  const [docs, setDocs] = React.useState<PartDoc[] | null>(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [adding, setAdding] = React.useState<null | "file" | "link">(null);
  const [kind, setKind] = React.useState("DATASHEET");
  const [url, setUrl] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const err = (e: unknown) => onError?.((e as Error).message);
  const key = target.scope === "LIBRARY" ? target.libraryElementId : `${target.projectId}/${target.elementId}/${target.libraryElementId ?? ""}`;

  const load = React.useCallback(async () => {
    try {
      const q =
        target.scope === "LIBRARY"
          ? `/api/library/elements/${target.libraryElementId}/documents`
          : `/api/documents?${new URLSearchParams({ projectId: target.projectId, elementId: target.elementId, ...(target.libraryElementId ? { libraryElementId: target.libraryElementId } : {}), ...(partNumber ? { partNumber } : {}) })}`;
      const j = await api<{ documents: PartDoc[]; canEdit: boolean }>(q);
      setDocs(j.documents);
      setCanEdit(j.canEdit);
    } catch (e) {
      setDocs([]);
      err(e);
    }
  }, [key, partNumber]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    setDocs(null);
    void load();
  }, [load]);

  const add = async (file?: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("scope", target.scope);
      if (target.scope === "LIBRARY") fd.set("libraryElementId", target.libraryElementId);
      else (fd.set("projectId", target.projectId), fd.set("elementId", target.elementId));
      fd.set("kind", kind);
      if (title.trim()) fd.set("title", title.trim());
      if (partNumber) fd.set("partNumber", partNumber);
      if (manufacturer) fd.set("manufacturer", manufacturer);
      if (file) fd.set("file", file);
      else fd.set("url", url.trim());
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`);
      setAdding(null);
      setUrl("");
      setTitle("");
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (d: PartDoc) => {
    try {
      await api(`/api/documents/${d.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      err(e);
    }
  };
  const search = [manufacturer, partNumber].filter(Boolean).join(" ");

  return (
    <div className={cn("space-y-1.5", !compact && "text-xs")}>
      {!docs ? (
        <Spinner />
      ) : docs.length ? (
        <ul className="space-y-1">
          {docs.map((d) => (
            <li key={d.id} className="group flex items-center gap-2 rounded-md border border-border px-2 py-1">
              <span className="text-muted [&_svg]:size-3.5">{ICON[d.kind] ?? <FileIcon />}</span>
              <a href={d.href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-2xs hover:underline" title={`${KIND_LABEL[d.kind] ?? d.kind} · ${d.title}${d.size ? ` · ${Math.round(d.size / 1024)} kB` : ""} · ${d.createdBy}`}>
                {d.title}
              </a>
              {ORIGIN[d.origin] && <Badge className="!h-4 shrink-0">{ORIGIN[d.origin]}</Badge>}
              {d.url ? <Link2 className="size-3 shrink-0 text-subtle" /> : <ExternalLink className="size-3 shrink-0 text-subtle" />}
              {canEdit && (d.origin === "component" || target.scope === "LIBRARY") && (
                <button className="text-subtle opacity-0 hover:text-danger group-hover:opacity-100" onClick={() => remove(d)} aria-label={`Remove ${d.title}`}>
                  <Trash2 className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-subtle">No datasheet or spec sheet yet.</p>
      )}
      {adding && (
        <div className="space-y-1.5 rounded-md border border-border bg-panel-2 p-2">
          <div className="flex gap-1">
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type" className="w-32">
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </NativeSelect>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" onKeyDown={(e) => e.stopPropagation()} />
          </div>
          {adding === "link" ? (
            <div className="flex gap-1">
              <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (manufacturer page or PDF)" onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && url.trim() && add())} />
              <Button size="xs" variant="primary" disabled={busy || !/^https?:\/\//i.test(url.trim())} onClick={() => add()}>
                Add
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Spinner /> : <Upload />} Choose file (PDF, image, STEP, ZIP … up to 25 MB)
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void add(f);
        }}
      />
      <div className="flex flex-wrap gap-1">
        {canEdit && !adding && (
          <>
            <Button size="xs" variant="secondary" onClick={() => setAdding("file")}>
              <Upload /> Upload
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setAdding("link")}>
              <Link2 /> Link
            </Button>
          </>
        )}
        {search && (
          <Button size="xs" variant="ghost" asChild>
            <a href={`https://www.google.com/search?q=${encodeURIComponent(`${search} datasheet pdf`)}`} target="_blank" rel="noopener noreferrer" title="Search the manufacturer's datasheet on the web">
              <Search /> Find online
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
