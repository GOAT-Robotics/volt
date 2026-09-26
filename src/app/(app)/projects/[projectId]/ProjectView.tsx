"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Star, GitBranchPlus, PenLine, ExternalLink, MoreHorizontal, Rocket, Undo2, ArchiveX, FileSignature, FileDown, FileCode2, FileArchive, Eye, Folder } from "lucide-react";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Empty, Spinner, Table, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/fetcher";
import { cn, fmtDate, relTime } from "@/lib/utils";
import { PromptDialog, useMutation } from "@/components/volt/common";
import type { CompatReport } from "@/core/model";
import type { FolderRow } from "../ProjectsView";
import { ReviewsTab, SignaturesTab, ActivityTab, MembersTab, AttachmentsTab, SettingsTab } from "./Tabs";

export type VersionRow = {
  id: string;
  label: string;
  status: string;
  summary: string;
  description: string;
  ticket: string | null;
  author: string;
  parentLabel: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  signedAt: string | null;
  releasedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  docHash: string | null;
  importId: string | null;
};
export type ReviewRow = {
  id: string;
  versionId: string;
  versionLabel: string;
  status: string;
  sequential: boolean;
  dueDate: string | null;
  instructions: string;
  submittedBy: string;
  createdAt: string;
  closedAt: string | null;
  assignments: { id: string; order: number; who: string; isGroup: boolean; canApprove: boolean; decision: string; reason: string | null; decidedBy: string | null; decidedAt: string | null }[];
};
export type SignatureRow = {
  id: string;
  versionId: string;
  versionLabel: string;
  status: string;
  order: number;
  purpose: string;
  signatory: { id: string; name: string; email: string };
  requestedBy: string;
  createdAt: string;
  expiresAt: string | null;
  signedAt: string | null;
  declineReason: string | null;
  docHash: string;
  pdfHash: string | null;
  provider: string;
  evidence: Record<string, unknown> | null;
  seal: string | null;
};
export type ProjectData = {
  me: { id: string; isAdmin: boolean };
  perms: { manage: boolean; edit: boolean; export: boolean; view: boolean };
  project: { id: string; name: string; number: string | null; description: string; tags: string[]; folderId: string | null; state: string; versionScheme: string; customScheme: string | null; createdAt: string; favorite: boolean; hasRelease: boolean };
  policy: { signatureRequiredForRelease: boolean; requiredSignatories: number; minApprovals: number };
  folders: FolderRow[];
  versions: VersionRow[];
  reviews: ReviewRow[];
  signatures: SignatureRow[];
  activity: { id: string; type: string; label: string; detail: string; actor: string; createdAt: string }[];
  members: { userId: string; name: string; email: string; isGuest: boolean; disabled: boolean; roles: string[] }[];
  attachments: { id: string; ownerType: string; ownerId: string; filename: string; mime: string; size: number; sha256: string; uploadedBy: string; uploadedById: string; createdAt: string; context: string }[];
  imports: { id: string; filename: string; sha256: string; createdAt: string; versionLabel: string | null; report: CompatReport | null }[];
  eligibleSignatories: { id: string; name: string; email: string }[];
};

export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const TABS = ["versions", "reviews", "signatures", "activity", "members", "attachments", "settings"] as const;
const WORKING = ["DRAFT", "CHANGES_REQUESTED"];

export function ProjectView({ data, initialTab }: { data: ProjectData; initialTab: string }) {
  const [tab, setTab] = React.useState<string>((TABS as readonly string[]).includes(initialTab) ? initialTab : "versions");
  const [run] = useMutation();
  const [startFrom, setStartFrom] = React.useState<VersionRow | null>(null);
  const p = data.project;
  const working = data.versions.find((v) => WORKING.includes(v.status));
  const latest = data.versions[0];
  const baseForNew = data.versions.find((v) => v.status === "RELEASED") ?? latest;
  const canStart = (data.perms.edit || data.perms.manage) && p.state === "ACTIVE" && !working;
  const changeTab = (t: string) => {
    setTab(t);
    const u = new URL(location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u);
  };
  const pendingSigs = data.signatures.filter((s) => s.status === "REQUESTED").length;
  const openReviews = data.reviews.filter((r) => r.status === "OPEN").length;
  const folder = data.folders.find((f) => f.id === p.folderId);

  return (
    <div>
      <PageHeader
        breadcrumb={
          <span className="flex items-center gap-1">
            <Link href="/projects" className="hover:text-fg hover:underline">
              Projects
            </Link>
            {folder && (
              <>
                <span aria-hidden>/</span>
                <Link href={`/projects?folder=${folder.id}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
                  <Folder className="size-3" /> {folder.name}
                </Link>
              </>
            )}
          </span>
        }
        title={
          <span className="flex items-center gap-2">
            {p.name}
            {p.number && <span className="font-mono text-xs font-normal text-muted">{p.number}</span>}
            {p.state === "ARCHIVED" && <Badge tone="warning">Archived</Badge>}
            <button
              onClick={() => run(() => api(`/api/projects/${p.id}/favorite`, { method: "POST" }))}
              aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={p.favorite}
              className={cn("rounded p-1 hover:bg-hover", p.favorite ? "text-amber-500" : "text-subtle hover:text-fg")}
            >
              <Star className="size-3.5" fill={p.favorite ? "currentColor" : "none"} />
            </button>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {p.description && <span className="mr-1">{p.description}</span>}
            {p.tags.map((t) => (
              <Link key={t} href={`/projects?tag=${encodeURIComponent(t)}`}>
                <Badge>{t}</Badge>
              </Link>
            ))}
          </span>
        }
        actions={
          working ? (
            <Button variant="primary" asChild>
              <Link href={`/projects/${p.id}/v/${working.id}`}>
                <PenLine /> Open working version v{working.label}
              </Link>
            </Button>
          ) : canStart && baseForNew ? (
            <Button variant="primary" onClick={() => setStartFrom(baseForNew)}>
              <GitBranchPlus /> Start new version
            </Button>
          ) : latest ? (
            <Button asChild>
              <Link href={`/projects/${p.id}/v/${latest.id}`}>
                <Eye /> Open v{latest.label}
              </Link>
            </Button>
          ) : null
        }
      />
      <TabsRoot value={tab} onValueChange={changeTab}>
        <TabsList className="bg-panel px-6">
          <TabsTrigger value="versions">Versions <Count n={data.versions.length} /></TabsTrigger>
          <TabsTrigger value="reviews">Reviews <Count n={openReviews} accent /></TabsTrigger>
          <TabsTrigger value="signatures">Signatures <Count n={pendingSigs} accent /></TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="members">Members <Count n={data.members.length} /></TabsTrigger>
          <TabsTrigger value="attachments">Attachments <Count n={data.attachments.length + data.imports.length} /></TabsTrigger>
          {data.perms.manage && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <div className="p-6">
          <TabsContent value="versions">
            <VersionsTab data={data} onStart={canStart ? setStartFrom : undefined} />
          </TabsContent>
          <TabsContent value="reviews">
            <ReviewsTab data={data} />
          </TabsContent>
          <TabsContent value="signatures">
            <SignaturesTab data={data} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab data={data} />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab data={data} />
          </TabsContent>
          <TabsContent value="attachments">
            <AttachmentsTab data={data} />
          </TabsContent>
          {data.perms.manage && (
            <TabsContent value="settings">
              <SettingsTab data={data} />
            </TabsContent>
          )}
        </div>
      </TabsRoot>
      {startFrom && <StartVersionDialog projectId={p.id} parent={startFrom} onClose={() => setStartFrom(null)} />}
    </div>
  );
}

function Count({ n, accent }: { n: number; accent?: boolean }) {
  if (!n) return null;
  return <span className={cn("ml-1 rounded-full px-1.5 text-[10px] font-semibold tabular-nums", accent ? "bg-accent text-white" : "bg-hover text-muted")}>{n}</span>;
}

function StartVersionDialog({ projectId, parent, onClose }: { projectId: string; parent: VersionRow; onClose: () => void }) {
  const router = useRouter();
  const [summary, setSummary] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [ticket, setTicket] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const j = await api<{ id: string; label: string }>(`/api/projects/${projectId}/versions`, { method: "POST", json: { parentId: parent.id, summary, description, ticket: ticket || undefined } });
      toast.success(`Version ${j.label} started`);
      router.push(`/projects/${projectId}/v/${j.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Start new version" description={`Copies the drawing of v${parent.label} (${parent.status.toLowerCase().replace("_", " ")}) into a new draft. The source stays unchanged.`}>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Summary of changes *">
            <Input autoFocus required value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Add second feeder, update motor protection" maxLength={500} />
          </Field>
          <Field label="Description">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Change ticket" hint="Optional reference (ECR/ECO number, issue link).">
            <Input value={ticket} onChange={(e) => setTicket(e.target.value)} maxLength={200} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !summary.trim()}>
              {busy && <Spinner />} Start & open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsTab({ data, onStart }: { data: ProjectData; onStart?: (v: VersionRow) => void }) {
  const [run] = useMutation();
  const [dlg, setDlg] = React.useState<{ kind: "release" | "withdraw" | "supersede" | "sign"; v: VersionRow } | null>(null);
  const pid = data.project.id;
  if (!data.versions.length) return <Empty title="No versions">This project has no versions yet.</Empty>;
  const canRelease = (s: string) => (data.policy.signatureRequiredForRelease ? s === "SIGNED" : s === "APPROVED" || s === "SIGNED");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel">
      <Table>
        <thead>
          <tr>
            <th className="w-20">Version</th>
            <th className="w-36">Status</th>
            <th>Summary</th>
            <th className="w-32">Author</th>
            <th className="w-40">Dates</th>
            <th className="w-44 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.versions.map((v) => {
            const frozen = !WORKING.includes(v.status);
            const pendingSig = data.signatures.some((s) => s.versionId === v.id && s.status === "REQUESTED");
            return (
              <tr key={v.id} className="align-top [&>td]:py-2">
                <td>
                  <Link href={`/projects/${pid}/v/${v.id}`} className="font-mono text-xs font-semibold hover:underline">
                    v{v.label}
                  </Link>
                  {v.parentLabel && <p className="text-2xs text-muted">from v{v.parentLabel}</p>}
                </td>
                <td>
                  <StatusBadge status={v.status} />
                  {pendingSig && <p className="mt-1 text-2xs text-muted">Awaiting signatures</p>}
                </td>
                <td className="max-w-md">
                  <p className="text-xs">{v.summary || <span className="text-muted">No summary</span>}</p>
                  {v.ticket && <p className="text-2xs text-muted">Ticket {v.ticket}</p>}
                  {v.endReason && <p className="text-2xs text-muted">{v.endReason}</p>}
                </td>
                <td className="text-xs">{v.author}</td>
                <td className="text-2xs text-muted">
                  <p title={fmtDate(v.createdAt)}>Created {relTime(v.createdAt)}</p>
                  {v.releasedAt && <p title={fmtDate(v.releasedAt)}>Released {fmtDate(v.releasedAt, false)}</p>}
                  {!v.releasedAt && v.approvedAt && <p title={fmtDate(v.approvedAt)}>Approved {fmtDate(v.approvedAt, false)}</p>}
                  {!v.approvedAt && v.submittedAt && <p title={fmtDate(v.submittedAt)}>Submitted {fmtDate(v.submittedAt, false)}</p>}
                </td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="xs" variant="ghost" asChild>
                      <Link href={`/projects/${pid}/v/${v.id}`}>
                        {WORKING.includes(v.status) && data.perms.edit ? <PenLine /> : <ExternalLink />} Open
                      </Link>
                    </Button>
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`More actions for v${v.label}`}>
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="end" className="w-56">
                        <MenuLabel>v{v.label}</MenuLabel>
                        {data.perms.manage && v.status === "APPROVED" && (
                          <MenuItem onSelect={() => setDlg({ kind: "sign", v })}>
                            <FileSignature /> Request signatures
                          </MenuItem>
                        )}
                        {data.perms.manage && canRelease(v.status) && (
                          <MenuItem onSelect={() => setDlg({ kind: "release", v })}>
                            <Rocket /> Release
                          </MenuItem>
                        )}
                        {data.perms.manage && v.status === "RELEASED" && (
                          <MenuItem onSelect={() => setDlg({ kind: "supersede", v })}>
                            <ArchiveX /> Mark superseded
                          </MenuItem>
                        )}
                        {data.perms.manage && ["IN_REVIEW", "APPROVED", "SIGNED", "RELEASED"].includes(v.status) && (
                          <MenuItem danger onSelect={() => setDlg({ kind: "withdraw", v })}>
                            <Undo2 /> Withdraw
                          </MenuItem>
                        )}
                        {onStart && (
                          <MenuItem onSelect={() => onStart(v)}>
                            <GitBranchPlus /> Start new version from here
                          </MenuItem>
                        )}
                        {data.perms.export && frozen && (
                          <>
                            <MenuSeparator />
                            <MenuItem onSelect={() => download(`/api/versions/${v.id}/canonical.pdf`)}>
<FileDown /> Drawing PDF (canonical)
</MenuItem>
                          </>
                        )}
                        {data.perms.export && ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED"].includes(v.status) && (
                          <MenuItem onSelect={() => download(`/api/versions/${v.id}/release.pdf`)}>
<FileSignature /> Release PDF with signature record
</MenuItem>
                        )}
                        {data.perms.export && ["RELEASED", "SUPERSEDED"].includes(v.status) && (
                          <MenuItem onSelect={() => download(`/api/versions/${v.id}/file.qet`)}>
<FileCode2 /> Project file (.qet)
</MenuItem>
                        )}
                        {v.importId && data.perms.view && (
                          <MenuItem onSelect={() => download(`/api/projects/${pid}/imports/${v.importId}/original`)}>
<FileArchive /> Original imported file
</MenuItem>
                        )}
                      </MenuContent>
                    </Menu>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {dlg?.kind === "release" && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Release v${dlg.v.label}?`}
          description={
            data.versions.some((x) => x.status === "RELEASED" && x.id !== dlg.v.id)
              ? `The currently released version (v${data.versions.find((x) => x.status === "RELEASED")!.label}) will be marked superseded. Everyone following this project is notified.`
              : "This becomes the released drawing of record. Everyone following this project is notified."
          }
          confirmLabel="Release"
          reason
          reasonLabel="Release note"
          reasonRequired={false}
          onConfirm={async (note) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/release`, { method: "POST", json: { note } }), `v${dlg.v.label} released`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "withdraw" && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Withdraw v${dlg.v.label}?`}
          description="Withdrawn versions stay in the history but must not be used. Open reviews and signature requests are cancelled."
          confirmLabel="Withdraw version"
          reason
          onConfirm={async (reason) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/withdraw`, { method: "POST", json: { reason } }), `v${dlg.v.label} withdrawn`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "supersede" && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Mark v${dlg.v.label} as superseded?`}
          description="Use this when a released drawing is replaced by another document or is no longer valid. Releasing a newer version does this automatically."
          confirmLabel="Mark superseded"
          reason
          onConfirm={async (reason) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/supersede`, { method: "POST", json: { reason } }), `v${dlg.v.label} superseded`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "sign" && <RequestSignaturesDialog data={data} v={dlg.v} onClose={() => setDlg(null)} />}
    </div>
  );
}

export function RequestSignaturesDialog({ data, v, onClose }: { data: ProjectData; v: VersionRow; onClose: () => void }) {
  const [run, busy] = useMutation();
  const [picked, setPicked] = React.useState<string[]>([]);
  const [purpose, setPurpose] = React.useState("Approval for release");
  const need = Math.max(1, data.policy.requiredSignatories);
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Request signatures for v${v.label}`} description={`Signatories sign in the order you select them. Policy requires at least ${need}.`}>
        <div className="space-y-3">
          <Field label="Purpose *">
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={500} />
          </Field>
          <fieldset>
            <legend className="mb-1 text-2xs font-medium text-muted">Signatories (users with the Signatory or Admin role)</legend>
            {data.eligibleSignatories.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted">No one has the Signatory role yet. An administrator can assign it under Administration → Members.</p>
            ) : (
              <ul className="max-h-60 overflow-auto rounded-md border border-border">
                {data.eligibleSignatories.map((u) => {
                  const i = picked.indexOf(u.id);
                  return (
                    <li key={u.id} className="border-b border-border last:border-0">
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover">
                        <Checkbox checked={i >= 0} onCheckedChange={() => toggle(u.id)} />
                        <span className="font-medium">{u.name}</span>
                        <span className="truncate text-muted">{u.email}</span>
                        {i >= 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">#{i + 1}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <p className="text-2xs text-muted">The server renders the canonical drawing PDF and records the SHA-256 hashes of the document and PDF; signatories confirm exactly these hashes.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || picked.length < need || !purpose.trim()}
            onClick={async () => {
              if (await run(() => api(`/api/versions/${v.id}/signatures`, { method: "POST", json: { signatoryIds: picked, purpose } }), "Signature requests sent")) onClose();
            }}
          >
            {busy && <Spinner />} Send requests
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
