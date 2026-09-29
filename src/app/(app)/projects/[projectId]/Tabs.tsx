"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCheck, FileSignature, ShieldCheck, ShieldAlert, Activity, Users, Paperclip, Upload, Download, Trash2, UserPlus, ExternalLink, FileJson, FileArchive, Mail, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Avatar, Badge, Checkbox, Empty, Spinner, Table } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, fmtDate, relTime } from "@/lib/utils";
import { PROJECT_ROLES, VERSION_SCHEMES } from "@/lib/constants";
import { ROLE_DESCRIPTION } from "@/lib/roles";
import { Mono, PromptDialog, Section, TagInput, UserSearch, useMutation } from "@/components/volt/common";
import { CompatReportView } from "../ImportQet";
import { folderOptions } from "../NewProjectDialog";
import type { ProjectData, SignatureRow } from "./ProjectView";

/* ------------------------------------------------------------------ */
/* Reviews                                                              */
/* ------------------------------------------------------------------ */

export function ReviewsTab({ data }: { data: ProjectData }) {
  if (!data.reviews.length)
    return (
      <Empty icon={<ClipboardCheck />} title="No reviews yet">
        Open the working version in the editor and choose <b>Submit for review</b> to freeze it and ask reviewers and approvers for a decision.
      </Empty>
    );
  return (
    <div className="space-y-4">
      {data.reviews.map((r) => (
        <Section
          key={r.id}
          title={
            <span className="flex items-center gap-2">
              Review of <span className="font-mono">v{r.versionLabel}</span> <StatusBadge status={r.status} />
              {r.sequential && <Badge>Sequential</Badge>}
            </span>
          }
          description={`Submitted by ${r.submittedBy} ${relTime(r.createdAt)}${r.dueDate ? ` · due ${fmtDate(r.dueDate, false)}` : ""}${r.closedAt ? ` · closed ${fmtDate(r.closedAt)}` : ""}`}
          actions={
            <Button size="xs" variant="ghost" asChild>
              <Link href={`/projects/${data.project.id}/v/${r.versionId}`}>
                <ExternalLink /> Open in editor
              </Link>
            </Button>
          }
        >
          {r.instructions && <p className="whitespace-pre-wrap border-b border-border px-4 py-2 text-xs text-muted">{r.instructions}</p>}
          <Table>
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Assignee</th>
                <th className="w-24">Role</th>
                <th className="w-40">Decision</th>
                <th>Reason</th>
                <th className="w-40">Decided</th>
              </tr>
            </thead>
            <tbody>
              {r.assignments.map((a) => (
                <tr key={a.id}>
                  <td className="tabular-nums text-muted">{a.order + 1}</td>
                  <td>
                    <span className="flex items-center gap-2">
                      {a.isGroup ? <Users className="size-3.5 text-muted" /> : <Avatar name={a.who} size={18} />}
                      {a.who}
                      {a.isGroup && <Badge>Entra group</Badge>}
                    </span>
                  </td>
                  <td className="text-2xs text-muted">{a.canApprove ? "Approver" : "Reviewer"}</td>
                  <td>
                    <StatusBadge status={a.decision === "PENDING" ? "PENDING" : a.decision} />
                  </td>
                  <td className="text-2xs">{a.reason ?? ""}</td>
                  <td className="text-2xs text-muted">{a.decidedAt ? `${a.decidedBy && a.decidedBy !== a.who ? `${a.decidedBy} · ` : ""}${fmtDate(a.decidedAt)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Signatures                                                           */
/* ------------------------------------------------------------------ */

type Verify = { valid: boolean; checks: { name: string; ok: boolean; detail: string }[] };

export function SignaturesTab({ data }: { data: ProjectData }) {
  const [evidence, setEvidence] = React.useState<SignatureRow | null>(null);
  const [results, setResults] = React.useState<Record<string, Verify | "loading">>({});
  const verify = async (id: string) => {
    setResults((r) => ({ ...r, [id]: "loading" }));
    try {
      const j = await api<Verify>(`/api/signatures/${id}/verify`);
      setResults((r) => ({ ...r, [id]: j }));
    } catch (e) {
      toast.error((e as Error).message);
      setResults((r) => {
        const n = { ...r };
        delete n[id];
        return n;
      });
    }
  };
  if (!data.signatures.length)
    return (
      <Empty icon={<FileSignature />} title="No signatures requested">
        {data.policy.signatureRequiredForRelease ? "This workspace requires signatures before release. " : ""}Once a version is approved, a project owner can request signatures from the Versions tab (⋯ → Request signatures).
      </Empty>
    );
  const byVersion = [...new Set(data.signatures.map((s) => s.versionId))];
  return (
    <div className="space-y-4">
      {byVersion.map((vid) => {
        const list = data.signatures.filter((s) => s.versionId === vid);
        return (
          <Section key={vid} title={<span>Signatures for <span className="font-mono">v{list[0].versionLabel}</span></span>} description={`${list.filter((s) => s.status === "SIGNED").length} of ${list.filter((s) => s.status !== "CANCELLED").length} signed`}>
            <ul className="divide-y divide-border">
              {list.map((s) => {
                const r = results[s.id];
                return (
                  <li key={s.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Avatar name={s.signatory.name} size={20} />
                      <span className="text-xs font-medium">{s.signatory.name}</span>
                      <StatusBadge status={s.status} />
                      <span className="text-2xs text-muted">
                        #{s.order + 1} · {s.purpose}
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        {s.status === "REQUESTED" && s.signatory.id === data.me.id && (
                          <Button size="xs" variant="primary" asChild>
                            <Link href={`/sign/${s.id}`}>
                              <FileSignature /> Sign now
                            </Link>
                          </Button>
                        )}
                        {s.status === "SIGNED" && (
                          <>
                            <Button size="xs" onClick={() => verify(s.id)} disabled={r === "loading"}>
                              {r === "loading" ? <Spinner /> : <ShieldCheck />} Verify
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => setEvidence(s)}>
                              <FileJson /> Evidence
                            </Button>
                          </>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-2xs text-muted">
                      Requested by {s.requestedBy} {relTime(s.createdAt)}
                      {s.signedAt && ` · signed ${fmtDate(s.signedAt)}`}
                      {s.status === "REQUESTED" && s.expiresAt && ` · expires ${fmtDate(s.expiresAt, false)}`}
                      {s.declineReason && ` · ${s.declineReason}`}
                    </p>
                    {r && r !== "loading" && (
                      <div className={cn("mt-2 rounded-md border px-3 py-2", r.valid ? "border-success/30 bg-success-soft" : "border-danger/30 bg-danger-soft")} role="status">
                        <p className={cn("flex items-center gap-1.5 text-xs font-semibold", r.valid ? "text-success" : "text-danger")}>
                          {r.valid ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                          {r.valid ? "Signature valid" : "Verification failed"}
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {r.checks.map((c) => (
                            <li key={c.name} className="flex gap-2 text-2xs">
                              <span className={cn("w-3 font-bold", c.ok ? "text-success" : "text-danger")}>{c.ok ? "✓" : "✗"}</span>
                              <span className="w-32 shrink-0 font-medium">{c.name}</span>
                              <span className="break-all text-muted">{c.detail}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}
      {evidence && (
        <Dialog open onOpenChange={(o) => !o && setEvidence(null)}>
          <DialogContent title={`Signature evidence — ${evidence.signatory.name}`} description={`v${evidence.versionLabel} · ${evidence.purpose}`} wide>
            <div className="space-y-3 text-xs">
              <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted">Signed at</dt>
                <dd>{fmtDate(evidence.signedAt)}</dd>
                <dt className="text-muted">Authenticated at</dt>
                <dd>{evidence.evidence?.authTime ? fmtDate(new Date(Number(evidence.evidence.authTime))) : "—"}</dd>
                <dt className="text-muted">IP address</dt>
                <dd>{String(evidence.evidence?.ip ?? "—")}</dd>
                <dt className="text-muted">Provider</dt>
                <dd>{evidence.provider}</dd>
                <dt className="text-muted">Document SHA-256</dt>
                <dd>
                  <Mono>{evidence.docHash}</Mono>
                </dd>
                <dt className="text-muted">PDF SHA-256</dt>
                <dd>
                  <Mono>{evidence.pdfHash ?? "—"}</Mono>
                </dd>
                <dt className="text-muted">Seal</dt>
                <dd>
                  <Mono>{evidence.seal ?? "—"}</Mono>
                </dd>
              </dl>
              <details>
                <summary className="cursor-pointer text-2xs font-medium text-muted">Canonical evidence JSON</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-panel-2 p-2 font-mono text-[10.5px] leading-snug">{JSON.stringify(evidence.evidence, null, 2)}</pre>
              </details>
            </div>
            <DialogFooter>
              <Button variant="ghost" asChild>
                <a href={`/api/signatures/${evidence.id}/verify`} target="_blank" rel="noreferrer">
                  <ExternalLink /> Verification JSON
                </a>
              </Button>
              <Button onClick={() => setEvidence(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                             */
/* ------------------------------------------------------------------ */

export function ActivityTab({ data }: { data: ProjectData }) {
  const [filter, setFilter] = React.useState("all");
  const groups: Record<string, string[]> = { all: [], versions: ["version.", "review.", "signature."], comments: ["comment."], exports: ["project.export"], project: ["project."] };
  const list = data.activity.filter((e) => filter === "all" || groups[filter].some((g) => e.type.startsWith(g)));
  if (!data.activity.length) return <Empty icon={<Activity />} title="No activity yet">Edits, reviews, signatures, exports and member changes are recorded here.</Empty>;
  return (
    <Section
      title="Activity"
      description="Audit trail for this project (latest 300 events)"
      actions={
        <div className="flex rounded-md border border-border bg-panel-2 p-0.5" role="group" aria-label="Filter activity">
          {Object.keys(groups).map((k) => (
            <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={cn("h-6 rounded px-2 text-2xs font-medium capitalize", filter === k ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg")}>
              {k}
            </button>
          ))}
        </div>
      }
    >
      <ol className="divide-y divide-border">
        {list.map((e) => (
          <li key={e.id} className="flex items-start gap-3 px-4 py-2">
            <Avatar name={e.actor} size={20} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className="font-medium">{e.actor}</span> <span className="text-muted">{e.label.toLowerCase()}</span>
                {e.detail && <span className="text-fg"> · {e.detail}</span>}
              </p>
            </div>
            <time className="shrink-0 text-2xs text-muted" dateTime={e.createdAt} title={fmtDate(e.createdAt)}>
              {relTime(e.createdAt)}
            </time>
          </li>
        ))}
        {!list.length && <li className="px-4 py-6 text-center text-xs text-muted">No events in this category.</li>}
      </ol>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Members                                                              */
/* ------------------------------------------------------------------ */

const ROLE_HELP: Record<string, string> = {
  OWNER: ROLE_DESCRIPTION.OWNER,
  DESIGNER: ROLE_DESCRIPTION.DESIGNER,
  REVIEWER: ROLE_DESCRIPTION.REVIEWER,
  APPROVER: ROLE_DESCRIPTION.APPROVER,
  SIGNATORY: ROLE_DESCRIPTION.SIGNATORY,
  VIEWER: ROLE_DESCRIPTION.VIEWER,
  GUEST: ROLE_DESCRIPTION.GUEST,
};

export function MembersTab({ data }: { data: ProjectData }) {
  const [run, busy] = useMutation();
  const [adding, setAdding] = React.useState(false);
  const [remove, setRemove] = React.useState<{ userId: string; name: string } | null>(null);
  const pid = data.project.id;
  const setRoles = (userId: string, roles: string[]) => {
    if (!roles.length) return toast.error("Keep at least one role, or remove the member");
    return run(() => api(`/api/projects/${pid}/members/${userId}`, { method: "PATCH", json: { roles } }), "Roles updated");
  };
  return (
    <Section
      title="Project members"
      description="Project roles add to workspace roles. People without a workspace role see only the projects they are members of."
      actions={
        data.perms.share && (
          <Button size="xs" variant="primary" onClick={() => setAdding(true)}>
            <UserPlus /> Add member
          </Button>
        )
      }
    >
      {data.members.length === 0 ? (
        <Empty icon={<Users />} title="No project members">Workspace members can access this project through their workspace roles. Add people here to give them project-specific roles or invite guests.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <th>Member</th>
                {PROJECT_ROLES.map((r) => (
                  <th key={r} className="w-20 text-center" title={ROLE_HELP[r]}>
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <span className="flex items-center gap-2">
                      <Avatar name={m.name} size={20} />
                      <span>
                        <span className="block text-xs font-medium">
                          {m.name} {m.isGuest && <Badge tone="warning">Guest</Badge>} {m.disabled && <Badge tone="danger">Disabled</Badge>}
                        </span>
                        <span className="block text-2xs text-muted">{m.email}</span>
                      </span>
                    </span>
                  </td>
                  {PROJECT_ROLES.map((r) => (
                    <td key={r} className="text-center">
                      <Checkbox
                        className="mx-auto"
                        checked={m.roles.includes(r)}
                        disabled={!data.perms.share || busy}
                        aria-label={`${r} role for ${m.name}`}
                        onCheckedChange={(c) => setRoles(m.userId, c ? [...m.roles, r] : m.roles.filter((x) => x !== r))}
                      />
                    </td>
                  ))}
                  <td>
                    {data.perms.share && (
                      <Button size="icon-sm" variant="danger-ghost" aria-label={`Remove ${m.name}`} onClick={() => setRemove({ userId: m.userId, name: m.name })}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {adding && <AddMemberDialog projectId={pid} exclude={data.members.map((m) => m.userId)} onClose={() => setAdding(false)} />}
      {remove && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setRemove(null)}
          title={`Remove ${remove.name}?`}
          description="They keep any workspace-level access. Their comments and decisions remain in the record."
          confirmLabel="Remove"
          onConfirm={async () => {
            if (await run(() => api(`/api/projects/${pid}/members/${remove.userId}`, { method: "DELETE" }), "Member removed")) setRemove(null);
          }}
        />
      )}
    </Section>
  );
}

function AddMemberDialog({ projectId, exclude, onClose }: { projectId: string; exclude: string[]; onClose: () => void }) {
  const [run, busy] = useMutation();
  const [mode, setMode] = React.useState<"search" | "email">("search");
  const [user, setUser] = React.useState<{ id: string; name: string; email: string } | null>(null);
  const [email, setEmail] = React.useState("");
  const [roles, setRoles] = React.useState<string[]>(["DESIGNER"]);
  const submit = async () => {
    const json = mode === "search" ? { userId: user?.id, roles } : { email, roles };
    if (await run(() => api(`/api/projects/${projectId}/members`, { method: "POST", json }), "Member added")) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add project member" description="Pick a workspace member, or invite someone by email (guests can then sign in and see only this project).">
        <div className="space-y-3">
          <div className="flex gap-1 rounded-md border border-border bg-panel-2 p-0.5 text-2xs" role="tablist">
            {(["search", "email"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("flex h-6 flex-1 items-center justify-center gap-1 rounded font-medium", mode === m ? "bg-panel shadow-sm" : "text-muted")}>
                {m === "search" ? <Search className="size-3" /> : <Mail className="size-3" />} {m === "search" ? "Workspace member" : "Invite by email"}
              </button>
            ))}
          </div>
          {mode === "search" ? (
            user ? (
              <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                <Avatar name={user.name} size={20} /> <span className="font-medium">{user.name}</span> <span className="text-muted">{user.email}</span>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setUser(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <UserSearch autoFocus onPick={setUser} exclude={exclude} />
            )
          ) : (
            <Field label="Email address">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoFocus />
            </Field>
          )}
          <fieldset>
            <legend className="mb-1 text-2xs font-medium text-muted">Project roles</legend>
            <div className="grid grid-cols-2 gap-1">
              {PROJECT_ROLES.map((r) => (
                <label key={r} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-hover">
                  <Checkbox className="mt-0.5" checked={roles.includes(r)} onCheckedChange={(c) => setRoles((x) => (c ? [...x, r] : x.filter((y) => y !== r)))} />
                  <span>
                    <span className="block text-xs font-medium">{r.charAt(0) + r.slice(1).toLowerCase()}</span>
                    <span className="block text-2xs text-muted">{ROLE_HELP[r]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !roles.length || (mode === "search" ? !user : !/^\S+@\S+\.\S+$/.test(email))}>
            {busy && <Spinner />} Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Attachments                                                          */
/* ------------------------------------------------------------------ */

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function AttachmentsTab({ data }: { data: ProjectData }) {
  const router = useRouter();
  const [run] = useMutation();
  const [uploading, setUploading] = React.useState(false);
  const [del, setDel] = React.useState<{ id: string; filename: string } | null>(null);
  const [report, setReport] = React.useState<ProjectData["imports"][number] | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const pid = data.project.id;
  const canUpload = (data.perms.edit || data.perms.manage) && data.project.state === "ACTIVE";
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        if (f.size > 25 * 1024 * 1024) {
          toast.error(`${f.name} exceeds the 25 MB limit`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", f);
        fd.append("ownerType", "PROJECT");
        fd.append("ownerId", pid);
        const res = await fetch(`/api/projects/${pid}/attachments`, { method: "POST", body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) toast.error(`${f.name}: ${j.error ?? "upload failed"}`);
        else toast.success(`Uploaded ${f.name}`);
      }
      router.refresh();
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="space-y-4">
      {data.imports.length > 0 && (
        <Section title="Imported source files" description="Original files are kept unchanged with their SHA-256 and compatibility report.">
          <ul className="divide-y divide-border">
            {data.imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <FileArchive className="size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{i.filename}</p>
                  <p className="text-2xs text-muted">
                    Imported {fmtDate(i.createdAt)} {i.versionLabel && `as v${i.versionLabel}`} · sha256 <Mono>{i.sha256.slice(0, 16)}…</Mono>
                  </p>
                </div>
                {i.report && (
                  <Button size="xs" variant="ghost" onClick={() => setReport(i)}>
                    <ClipboardCheck /> Compatibility report
                  </Button>
                )}
                <Button size="xs" variant="ghost" asChild>
                  <a href={`/api/projects/${pid}/imports/${i.id}/report`}>
                    <FileJson /> Report JSON
                  </a>
                </Button>
                <Button size="xs" asChild>
                  <a href={`/api/projects/${pid}/imports/${i.id}/original`}>
                    <Download /> Original .qet
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        title="Attachments"
        description="Specifications, datasheets, review evidence (25 MB max per file)."
        actions={
          canUpload && (
            <>
              <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => upload(e.target.files)} />
              <Button size="xs" variant="primary" onClick={() => input.current?.click()} disabled={uploading}>
                {uploading ? <Spinner /> : <Upload />} Upload files
              </Button>
            </>
          )
        }
      >
        {data.attachments.length === 0 ? (
          <Empty icon={<Paperclip />} title="No attachments">
            {canUpload ? "Upload datasheets, specifications or site photos. Files added when submitting a review appear here too." : "Files attached to this project or its reviews appear here."}
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>File</th>
                <th className="w-32">Context</th>
                <th className="w-20 text-right">Size</th>
                <th className="w-40">Uploaded</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {data.attachments.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/api/attachments/${a.id}`} className="text-xs font-medium hover:underline">
                      {a.filename}
                    </a>
                    <p className="text-2xs text-muted">
                      sha256 <Mono>{a.sha256.slice(0, 12)}…</Mono>
                    </p>
                  </td>
                  <td className="text-2xs text-muted">{a.context}</td>
                  <td className="text-right text-2xs tabular-nums">{fmtSize(a.size)}</td>
                  <td className="text-2xs text-muted">
                    {a.uploadedBy} · {relTime(a.createdAt)}
                  </td>
                  <td className="text-right">
                    <Button size="icon-sm" variant="ghost" asChild>
                      <a href={`/api/attachments/${a.id}`} aria-label={`Download ${a.filename}`}>
                        <Download />
                      </a>
                    </Button>
                    {(a.uploadedById === data.me.id || data.perms.manage) && (
                      <Button size="icon-sm" variant="danger-ghost" aria-label={`Delete ${a.filename}`} onClick={() => setDel({ id: a.id, filename: a.filename })}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
      {del && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDel(null)}
          title={`Delete ${del.filename}?`}
          description="Files attached to submitted or released versions cannot be deleted."
          confirmLabel="Delete"
          onConfirm={async () => {
            if (await run(() => api(`/api/attachments/${del.id}`, { method: "DELETE" }), "File deleted")) setDel(null);
          }}
        />
      )}
      {report?.report && (
        <Dialog open onOpenChange={(o) => !o && setReport(null)}>
          <DialogContent title={`Compatibility report — ${report.filename}`} description={`${report.report.pageCount} pages · ${report.report.elementCount} components · ${report.report.wireCount} wires · format ${report.report.qetVersion}`} wide="xl">
            <CompatReportView report={report.report} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

export function SettingsTab({ data }: { data: ProjectData }) {
  const router = useRouter();
  const p = data.project;
  const [run, busy] = useMutation();
  const [f, setF] = React.useState({ name: p.name, number: p.number ?? "", description: p.description, tags: p.tags, folderId: p.folderId ?? "", versionScheme: p.versionScheme, customScheme: p.customScheme ?? "R{n}" });
  const [confirm, setConfirm] = React.useState<"archive" | "delete" | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api(`/api/projects/${p.id}`, {
          method: "PATCH",
          json: { name: f.name, number: f.number || null, description: f.description, tags: f.tags, folderId: f.folderId || null, versionScheme: f.versionScheme, customScheme: f.versionScheme === "CUSTOM" ? f.customScheme : null },
        }),
      "Project settings saved",
    );
  };
  return (
    <div className="max-w-2xl space-y-4">
      <Section title="General">
        <form onSubmit={save} className="grid grid-cols-2 gap-3 p-4">
          <Field label="Name" className="col-span-2 sm:col-span-1">
            <Input required value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
          </Field>
          <Field label="Project number" className="col-span-2 sm:col-span-1">
            <Input value={f.number} onChange={(e) => set("number", e.target.value)} maxLength={60} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <Field label="Tags" className="col-span-2 sm:col-span-1">
            <TagInput value={f.tags} onChange={(v) => set("tags", v)} />
          </Field>
          <Field label="Folder" className="col-span-2 sm:col-span-1">
            <NativeSelect value={f.folderId} onChange={(e) => set("folderId", e.target.value)} disabled={!data.folders.length}>
              <option value="">No folder</option>
              {folderOptions(data.folders).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Version numbering" hint={p.hasRelease ? "Locked: this project has been released." : "Applies to the next version started."}>
            <NativeSelect value={f.versionScheme} onChange={(e) => set("versionScheme", e.target.value)} disabled={p.hasRelease}>
              {VERSION_SCHEMES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {f.versionScheme === "CUSTOM" ? (
            <Field label="Pattern">
              <Input value={f.customScheme} onChange={(e) => set("customScheme", e.target.value)} disabled={p.hasRelease} />
            </Field>
          ) : (
            <div />
          )}
          <div className="col-span-2 flex justify-end">
            <Button type="submit" variant="primary" disabled={busy || !f.name.trim()}>
              {busy && <Spinner />} Save changes
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Archive" description={p.state === "ARCHIVED" ? "Archived projects are read-only and hidden from the default project list." : "Archiving makes the project read-only and hides it from the default list. You can restore it at any time."}>
        <div className="flex items-center justify-between p-4">
          <p className="text-xs text-muted">Status: {p.state === "ARCHIVED" ? "Archived" : "Active"}</p>
          <Button onClick={() => setConfirm("archive")}>{p.state === "ARCHIVED" ? "Restore project" : "Archive project"}</Button>
        </div>
      </Section>
      {data.me.isAdmin && (
        <Section title={<span className="text-danger">Danger zone</span>} description="Permanently deletes the project, all versions, reviews, signatures and files. Workspace audit entries are kept.">
          <div className="flex justify-end p-4">
            <Button variant="danger" onClick={() => setConfirm("delete")}>
              <Trash2 /> Delete project
            </Button>
          </div>
        </Section>
      )}
      {confirm === "archive" && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={p.state === "ARCHIVED" ? "Restore project?" : "Archive project?"}
          confirmLabel={p.state === "ARCHIVED" ? "Restore" : "Archive"}
          onConfirm={async () => {
            if (await run(() => api(`/api/projects/${p.id}`, { method: "PATCH", json: { state: p.state === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" } }), p.state === "ARCHIVED" ? "Project restored" : "Project archived")) setConfirm(null);
          }}
        />
      )}
      {confirm === "delete" && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Delete project permanently?"
          description="This cannot be undone. Released drawings and signature records of this project will no longer be available."
          confirmLabel="Delete forever"
          typeToConfirm={p.name}
          onConfirm={async () => {
            const ok = await run(() => api(`/api/projects/${p.id}`, { method: "DELETE", json: { confirm: p.name } }), "Project deleted", { refresh: false });
            if (ok) router.push("/projects");
          }}
        />
      )}
    </div>
  );
}
