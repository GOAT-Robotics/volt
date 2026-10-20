"use client";
/**
 * Sharing projects as .volt files: the export dialog (whole project or one version) and the import
 * dialog (open as a new project, or merge the reviews of a reviewed copy back).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, FileBox, GitMerge, MessageSquare, ShieldAlert, ShieldCheck, Upload, AlertTriangle, FolderPlus, ArrowRight } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Checkbox, Spinner } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { TagInput } from "@/components/volt/common";
import { CompatReportView } from "@/components/volt/CompatReport";
import { cn, downloadBlob, fmtDate } from "@/lib/utils";
import type { MergeResult, VoltInspection } from "@/lib/voltfile/types";
import type { FolderRow } from "@/app/(app)/projects/ProjectsView";
import { folderOptions } from "@/app/(app)/projects/NewProjectDialog";

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n: number, w: string, pl = w + "s") => `${n} ${n === 1 ? w : pl}`;

function filenameOf(res: Response, fallback: string) {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) return decodeURIComponent(star);
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? fallback;
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */

export function VoltExportDialog({
  open,
  onClose,
  project,
  version,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  project: { id: string; name: string; versions: number };
  /** one version (to send for review); omitted: the whole project */
  version?: { id: string; label: string; status: string } | null;
  canManage: boolean;
}) {
  const [reviews, setReviews] = React.useState(true);
  const [history, setHistory] = React.useState(true);
  const [files, setFiles] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const whole = !version;
  const download = async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ reviews: reviews ? "1" : "0", files: files ? "1" : "0", ...(whole ? { history: history ? "1" : "0" } : {}) });
      const res = await fetch(whole ? `/api/projects/${project.id}/export.volt?${q}` : `/api/versions/${version!.id}/export.volt?${q}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Export failed (${res.status})`);
      const name = filenameOf(res, `${project.name}.volt`);
      downloadBlob(await res.blob(), name);
      toast.success(`Downloaded ${name}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const Opt = ({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }) => (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5 hover:bg-hover">
      <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <span>
        <span className="block text-xs font-medium">{title}</span>
        <span className="block text-2xs text-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent title={whole ? "Download project as .volt" : `Share v${version!.label} as .volt`} description={whole ? `${project.name} — ${plural(project.versions, "version")}, in one file you can share and upload into any Volt` : `${project.name} v${version!.label} with its review, to send to a reviewer`}>
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-md border border-border bg-panel-2 p-3">
            <FileBox className="mt-0.5 size-5 shrink-0 text-accent" />
            <p className="text-2xs leading-relaxed text-muted">
              {whole ? (
                <>Every version and variant with its drawing. Whoever uploads it gets a new project; versions that were submitted, approved or released come in as read-only records.</>
              ) : (
                <>
                  The reviewer uploads it into their Volt, comments on the drawing and exports their copy back to you. Upload that file here (Projects → Import) and choose <b>Merge reviews back</b>: their comments land on v{version!.label}.
                </>
              )}
            </p>
          </div>
          <div>
            <Opt checked={reviews} onChange={setReviews} title="Comments and reviews" hint="Comment threads, review decisions and signature records" />
            {whole && <Opt checked={history} onChange={setHistory} title="Commit history" hint="Every commit with its message, so history and compare work after import" />}
            <Opt checked={files} onChange={setFiles} title="Attachments and datasheets" hint="Files on the project, its comments and reviews, and documents of placed components" />
          </div>
          <p className="text-2xs text-muted">
            The file is sealed with this server's key, so Volt can tell when it comes back unchanged.{reviews ? " It names the people who commented, reviewed and signed (name and email)." : ""}
            {reviews && canManage ? " Signature evidence (sign-in time, IP address, browser) is included because you manage this project." : ""}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={download} disabled={busy}>
            {busy ? <Spinner /> : <Download />} Download .volt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

function SealLine({ seal, server }: { seal: VoltInspection["seal"]; server: VoltInspection["server"] }) {
  const good = seal.state === "this-server" || seal.state === "valid";
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-2xs", good ? "border-success/25 bg-success-soft" : "border-warning/30 bg-warning-soft")}>
      {good ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />}
      <span>
        <b className={good ? "text-success" : "text-warning"}>{seal.state === "this-server" ? "Sealed by this server" : seal.state === "valid" ? `Sealed by ${server.name}` : seal.state === "unsealed" ? "Not sealed" : "Seal does not verify"}</b>
        <span className="text-fg"> — {seal.detail}</span>
      </span>
    </div>
  );
}

/**
 * Upload dialog for a .volt file. `prefer="merge"` (from a project page) opens on "Merge reviews
 * back" when the file is a reviewed copy of one of the user's versions.
 */
export function VoltImportDialog({ file, folders, currentFolder, prefer, onClose }: { file: File; folders: FolderRow[]; currentFolder: string | null; prefer?: "merge" | "new"; onClose: () => void }) {
  const router = useRouter();
  const [info, setInfo] = React.useState<VoltInspection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"merge" | "new">("new");
  const [targets, setTargets] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [number, setNumber] = React.useState("");
  const [folderId, setFolderId] = React.useState(currentFolder ?? "");
  const [tags, setTags] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let off = false;
    const fd = new FormData();
    fd.append("file", file);
    fetch("/api/volt/inspect", { method: "POST", body: fd })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `Could not read the file (${r.status})`);
        return j as VoltInspection;
      })
      .then((j) => {
        if (off) return;
        setInfo(j);
        setName(j.project.name);
        setNumber(j.numberTaken ? "" : j.project.number ?? "");
        setTags([...new Set([...j.project.tags, "imported"])].slice(0, 20));
        const mergeable = j.merge.filter((m) => m.canMerge);
        setTargets(mergeable.map((m) => m.versionId));
        setMode(mergeable.length && prefer !== "new" ? "merge" : "new");
      })
      .catch((e: Error) => !off && setError(e.message));
    return () => {
      off = true;
    };
  }, [file, prefer]);

  const submit = async () => {
    if (!info) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", mode);
      if (mode === "merge") fd.append("targets", JSON.stringify(targets));
      else {
        fd.append("name", name);
        if (number) fd.append("number", number);
        if (folderId) fd.append("folderId", folderId);
        fd.append("tags", JSON.stringify(tags));
      }
      const res = await fetch("/api/volt/import", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Import failed (${res.status})`);
      if (mode === "merge") {
        const r = j as MergeResult;
        const first = r.merged[0];
        const n = r.merged.reduce((s, m) => s + m.threads + m.replies + m.decisions, 0);
        toast.success(`Merged ${plural(n, "comment")} into ${r.merged.map((m) => `v${m.label}`).join(", ")}`);
        if (first) router.push(`/projects/${first.projectId}/v/${first.versionId}?panel=review`);
        else router.refresh();
      } else {
        toast.success(`Imported ${file.name}`);
        router.push(`/projects/${j.id}`);
      }
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const mergeable = info?.merge.filter((m) => m.canMerge) ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        wide="xl"
        title={info ? `Import ${info.scope === "version" ? `v${info.versions[0]?.label} of ` : ""}${info.project.name}` : "Import .volt file"}
        description={info ? `${file.name} · ${kb(file.size)} · exported ${fmtDate(info.createdAt)} by ${info.exportedBy} from ${info.server.name}` : `${file.name} · ${kb(file.size)}`}
      >
        {!info && !error && (
          <p className="flex items-center gap-2 py-10 text-xs text-muted justify-center">
            <Spinner /> Checking the file…
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5 text-xs text-danger">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
          </div>
        )}
        {info && (
          <div className="space-y-3">
            <SealLine seal={info.seal} server={info.server} />
            {info.merge.length > 0 && (
              <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label="What to do with the file">
                <ModeCard active={mode === "merge"} disabled={!mergeable.length} onClick={() => setMode("merge")} icon={<GitMerge />} title="Merge reviews back" hint={mergeable.length ? `This is a reviewed copy of your ${info.merge.map((m) => `${m.projectName} v${m.label}`).join(", ")}. Add the new comments there.` : info.merge[0]?.reason ?? "Nothing to merge"} />
                <ModeCard active={mode === "new"} disabled={!info.canCreate} onClick={() => setMode("new")} icon={<FolderPlus />} title="Import as a new project" hint={info.canCreate ? "A separate project with everything in the file" : "Your role cannot create projects"} />
              </div>
            )}
            {mode === "merge" ? <MergePanel info={info} targets={targets} setTargets={setTargets} /> : (
              <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-panel-2 p-3">
                    <p className="mb-1.5 text-xs font-semibold">{info.scope === "version" ? "Version" : `${plural(info.versions.length, "version")}`}</p>
                    <ul className="space-y-1">
                      {info.versions.map((v) => (
                        <li key={v.label} className="flex flex-wrap items-center gap-1.5 text-2xs">
                          <span className="w-14 font-mono font-semibold">v{v.label}</span>
                          <StatusBadge status={v.status} />
                          <ArrowRight className="size-3 text-subtle" />
                          {v.importsAs === "DRAFT" ? <Badge tone="success">Working version</Badge> : <Badge tone="accent">Read-only record</Badge>}
                          {v.comments > 0 && (
                            <span className="ml-auto flex items-center gap-0.5 text-muted">
                              <MessageSquare className="size-3" /> {v.comments}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-border pt-2 text-2xs">
                      <dt className="text-muted">Pages · components · wires</dt>
                      <dd className="font-medium tabular-nums">
                        {info.report.pageCount} · {info.report.elementCount} · {info.report.wireCount}
                      </dd>
                      <dt className="text-muted">Comments · reviews · signatures</dt>
                      <dd className="font-medium tabular-nums">{info.includes.reviews ? `${info.counts.comments} · ${info.counts.reviews} · ${info.counts.signatures}` : "not included"}</dd>
                      {info.scope === "project" && (
                        <>
                          <dt className="text-muted">Commits · files</dt>
                          <dd className="font-medium tabular-nums">
                            {info.includes.history ? info.counts.commits : "—"} · {info.includes.files ? info.counts.files : "—"}
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                  <Field label="Project name *">
                    <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
                  </Field>
                  <Field label="Project number" hint={info.numberTaken ? `${info.project.number} is already used here` : undefined}>
                    <Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} placeholder={info.numberTaken ? `not ${info.project.number}` : undefined} />
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
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold">What comes in</p>
                  <CompatReportView report={info.report} />
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {info && mode === "merge" && (
            <Button variant="primary" onClick={submit} disabled={busy || !targets.length}>
              {busy ? <Spinner /> : <GitMerge />} Merge into {info.merge.filter((m) => targets.includes(m.versionId)).map((m) => `v${m.label}`).join(", ") || "…"}
            </Button>
          )}
          {info && mode === "new" && (
            <Button variant="primary" onClick={submit} disabled={busy || !name.trim() || !info.canCreate}>
              {busy ? <Spinner /> : <Upload />} Import & open
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeCard({ active, disabled, onClick, icon, title, hint }: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; title: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", active ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")}
    >
      <span className={cn("mt-0.5 [&_svg]:size-4", active ? "text-accent" : "text-muted")}>{icon}</span>
      <span>
        <span className="block text-xs font-semibold">{title}</span>
        <span className="block text-2xs text-muted">{hint}</span>
      </span>
    </button>
  );
}

function MergePanel({ info, targets, setTargets }: { info: VoltInspection; targets: string[]; setTargets: (t: string[]) => void }) {
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-md border border-border">
        {info.merge.map((m) => {
          const on = targets.includes(m.versionId);
          return (
            <li key={m.versionId} className={cn("flex items-start gap-3 px-3 py-2.5", !m.canMerge && "opacity-60")}>
              <Checkbox className="mt-0.5" disabled={!m.canMerge} checked={on} onCheckedChange={(c) => setTargets(c === true ? [...targets, m.versionId] : targets.filter((t) => t !== m.versionId))} aria-label={`Merge into v${m.label}`} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-xs">
                  <b>{m.projectName}</b>
                  {m.projectNumber && <span className="font-mono text-2xs text-muted">{m.projectNumber}</span>}
                  <span className="font-mono font-semibold">v{m.label}</span>
                  <StatusBadge status={m.status} />
                  <span className="text-2xs text-muted">← reviewed copy v{m.fileLabel} from {info.server.name}</span>
                </p>
                {m.canMerge ? (
                  <p className="mt-0.5 text-2xs">
                    {[m.newThreads && plural(m.newThreads, "new comment thread"), m.newReplies && plural(m.newReplies, "reply", "replies"), m.decisions && plural(m.decisions, "review decision"), m.files && plural(m.files, "file")].filter(Boolean).join(" · ")}
                  </p>
                ) : (
                  <p className="mt-0.5 text-2xs text-muted">{m.reason}</p>
                )}
                {m.automated > 0 && (
                  <p className="mt-0.5 text-2xs text-muted">
                    {plural(m.automated, "automated finding")} of their AI reviewer {m.automated === 1 ? "is" : "are"} left out — run the AI review here instead.
                  </p>
                )}
                {m.drawingChanged && m.canMerge && (
                  <p className="mt-1 flex items-start gap-1 text-2xs text-warning">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" /> The drawing in the file differs from v{m.label}. Comments are placed where the reviewer made them; drawing changes are not merged — import the file as a new project to see them.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-2xs text-muted">
        New comments keep their author&apos;s name and email{info.server.thisServer ? "" : ` from ${info.server.name}`} and show that you imported them. Review decisions made on the copy become comments: they never count as approvals here. Comments already on the version are not added twice, so merging the same file again changes nothing.
      </p>
    </div>
  );
}
