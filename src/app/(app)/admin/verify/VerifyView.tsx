"use client";
import * as React from "react";
import Link from "next/link";
import { FileSearch, Upload, CheckCircle2, XCircle, AlertTriangle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, Spinner, Table } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, fmtDate } from "@/lib/utils";

type Person = { id: string; name: string; email: string } | null;
type Proj = { id: string; name: string; number: string | null } | null;
type Ver = { id: string; label: string; status: string } | null;
export type CopyRow = { code: string; at: string; ip: string | null; by: Person; project: Proj; version: Ver };
type CopyInfo = CopyRow & { userAgent: string; sha256: string };
type Result = {
  match: "exact" | "code" | "none";
  fileSha256: string;
  copy: CopyInfo | null;
  signature: { present: boolean; intact: boolean; valid: boolean; coversWholeFile: boolean; signer: string | null; certFingerprint: string | null; ours: boolean; error?: string };
};

export function VerifyView({ recent }: { recent: CopyRow[] }) {
  const [busy, setBusy] = React.useState(false);
  const [drag, setDrag] = React.useState(false);
  const [file, setFile] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Result | null>(null);
  const [byCode, setByCode] = React.useState<{ code: string; copy: CopyInfo | null } | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);

  const upload = async (f: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setByCode(null);
    setFile(f.name);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/admin/verify-pdf", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Verification failed");
      setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const j = await api<{ copy: CopyInfo | null }>(`/api/admin/verify-pdf?code=${encodeURIComponent(code)}`);
      setByCode({ code: code.trim().toUpperCase(), copy: j.copy });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const shown = recent.filter((r) => !q.trim() || `${r.code} ${r.by?.name} ${r.by?.email} ${r.project?.name} ${r.project?.number} v${r.version?.label}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="space-y-4 p-6">
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
          className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-panel p-8 text-center", drag ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong")}
        >
          {busy ? <Spinner /> : <Upload className="size-6 text-subtle" />}
          <span className="text-sm font-medium">{busy ? `Checking ${file ?? ""}…` : "Drop a release PDF here, or click to choose one"}</span>
          <span className="text-2xs text-muted">The file is checked here and not kept.</span>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </label>
        <form onSubmit={lookup} className="flex flex-col justify-center gap-2 rounded-lg border border-border bg-panel p-4">
          <span className="text-xs font-medium">From a printed page</span>
          <span className="text-2xs text-muted">Type the copy code from the green stamp in the corner of the page.</span>
          <div className="flex gap-1">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VLT-7KQ2-9XHM" className="font-mono uppercase" aria-label="Copy code" />
            <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
              <Search /> Find
            </Button>
          </div>
        </form>
      </div>

      {error && <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {result && <ResultCard r={result} file={file} />}
      {byCode && (
        <div className="rounded-lg border border-border bg-panel p-4">
          {byCode.copy ? <CopyDetails c={byCode.copy} title={`Copy ${byCode.copy.code}`} /> : <p className="text-sm">No copy with the code {byCode.code} was downloaded in this workspace.</p>}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <span className="text-xs font-semibold">Downloaded copies</span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by person, project, code…" className="h-7 w-64 text-xs" aria-label="Filter downloads" />
        </div>
        {!shown.length ? (
          <Empty icon={<FileSearch />} title="No downloads yet">
            Downloads of released drawings appear here.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className="w-44">When</th>
                <th>Downloaded by</th>
                <th>Project</th>
                <th className="w-20">Version</th>
                <th className="w-36">Copy code</th>
                <th className="w-32">IP address</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.code}>
                  <td className="text-2xs">{fmtDate(r.at)}</td>
                  <td className="text-xs">
                    {r.by?.name ?? "Unknown"} <span className="text-muted">{r.by?.email}</span>
                  </td>
                  <td className="text-xs">{r.project ? <Link href={`/projects/${r.project.id}`} className="hover:underline">{r.project.number ? `${r.project.number} · ` : ""}{r.project.name}</Link> : "—"}</td>
                  <td className="text-xs">{r.version && r.project ? <Link href={`/projects/${r.project.id}/v/${r.version.id}`} className="font-mono hover:underline">v{r.version.label}</Link> : "—"}</td>
                  <td className="font-mono text-2xs">{r.code}</td>
                  <td className="text-2xs text-muted">{r.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ResultCard({ r, file }: { r: Result; file: string | null }) {
  const s = r.signature;
  const changed = r.match === "code" || (s.present && !s.intact);
  return (
    <div className={cn("rounded-lg border bg-panel p-4", r.match === "exact" && s.intact && s.valid ? "border-success/40" : r.match === "none" ? "border-border" : "border-warning/40")}>
      <p className="mb-3 text-2xs text-muted">{file}</p>
      {r.match === "none" ? (
        <p className="text-sm font-medium">This file is not a copy downloaded from Volt in this workspace{s.present ? "" : " — it has no digital signature"}.</p>
      ) : (
        <CopyDetails c={r.copy!} title={r.match === "exact" ? "Exactly the file that was downloaded" : "A downloaded copy — but this file was changed after the download"} warn={changed} />
      )}
      <ul className="mt-3 space-y-1 text-xs">
        <Check ok={r.match === "exact"} warn={r.match === "code"} label={r.match === "exact" ? "Same bytes as the downloaded copy (SHA-256)" : r.match === "code" ? "The copy code was found, but the file’s bytes differ from what was downloaded" : "No downloaded copy has this file’s SHA-256"} />
        <Check ok={s.present && s.intact} warn={!s.present} label={!s.present ? "No digital signature in the file" : s.intact ? "Digital signature intact — the file was not changed after signing" : s.error ?? "The file was changed after it was signed"} />
        {s.present && <Check ok={s.valid} label={s.valid ? "Signature verifies with its certificate" : "The signature does not verify"} />}
        {s.present && <Check ok={s.ours} warn={!s.ours} label={s.ours ? "Signed with this Volt’s release certificate" : `Signed by another certificate${s.signer ? ` (${s.signer})` : ""}`} />}
      </ul>
      <p className="mt-3 break-all font-mono text-[10px] text-subtle">file SHA-256 {r.fileSha256}</p>
    </div>
  );
}

function CopyDetails({ c, title, warn }: { c: CopyInfo; title: string; warn?: boolean }) {
  return (
    <div>
      <p className={cn("flex items-center gap-1.5 text-sm font-semibold", warn ? "text-warning" : "text-success")}>
        {warn ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />} {title}
      </p>
      <dl className="mt-2 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Copy code</dt>
        <dd className="font-mono">{c.code}</dd>
        <dt className="text-muted">Downloaded by</dt>
        <dd>
          {c.by?.name ?? "Unknown"} <span className="text-muted">{c.by?.email}</span>
        </dd>
        <dt className="text-muted">When</dt>
        <dd>{fmtDate(c.at)}</dd>
        <dt className="text-muted">Project</dt>
        <dd>
          {c.project ? (
            <Link href={`/projects/${c.project.id}`} className="hover:underline">
              {c.project.number ? `${c.project.number} · ` : ""}
              {c.project.name}
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted">Version</dt>
        <dd className="flex items-center gap-2">
          {c.version && c.project ? (
            <>
              <Link href={`/projects/${c.project.id}/v/${c.version.id}`} className="font-mono hover:underline">
                v{c.version.label}
              </Link>
              <StatusBadge status={c.version.status} />
              {c.version.status !== "RELEASED" && <span className="text-2xs text-warning">no longer the current release</span>}
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted">IP address</dt>
        <dd>{c.ip ?? "—"}</dd>
        <dt className="text-muted">Browser</dt>
        <dd className="truncate text-muted" title={c.userAgent}>
          {c.userAgent || "—"}
        </dd>
      </dl>
    </div>
  );
}

function Check({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  return (
    <li className="flex items-start gap-1.5">
      {ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : warn ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />}
      <span>{label}</span>
    </li>
  );
}
