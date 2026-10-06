"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Star, GitBranchPlus, PenLine, ExternalLink, MoreHorizontal, Rocket, Undo2, ArchiveX, FileSignature, FileDown, FileCode2, FileArchive, Eye, Folder, GitFork, RotateCcw, Ban, Archive, ArchiveRestore, Pencil, Lock } from "lucide-react";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Empty, Spinner, Table, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/fetcher";
import { cn, fmtDate, relTime } from "@/lib/utils";
import { PromptDialog, Section, useMutation } from "@/components/volt/common";
import type { CompatReport } from "@/core/model";
import type { FolderRow } from "../ProjectsView";
import { ReviewsTab, SignaturesTab, ActivityTab, MembersTab, AttachmentsTab, SettingsTab } from "./Tabs";
import { LiveStack, useLivePeople } from "@/components/live/LiveNow";

export type VersionRow = {
  id: string;
  label: string;
  status: string;
  variantId: string | null;
  seq: number;
  createdById: string;
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
export type VariantRow = { id: string; code: string; name: string; customer: string; description: string; baseVersionId: string; baseLabel: string; state: string; createdBy: string; createdAt: string };
export type ProjectData = {
  me: { id: string; isAdmin: boolean };
  perms: { manage: boolean; requestSignatures: boolean; share: boolean; edit: boolean; export: boolean; view: boolean; approve: boolean };
  variants: VariantRow[];
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
/** a variant branches from a main-line version that is not a draft in progress or abandoned */
const NOT_A_BASE = ["DRAFT", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN"];

export function ProjectView({ data, initialTab }: { data: ProjectData; initialTab: string }) {
  const [tab, setTab] = React.useState<string>((TABS as readonly string[]).includes(initialTab) ? initialTab : "versions");
  const [run] = useMutation();
  const [startFrom, setStartFrom] = React.useState<VersionRow | null>(null);
  const [variantFrom, setVariantFrom] = React.useState<VersionRow | null>(null);
  const p = data.project;
  const main = data.versions.filter((v) => !v.variantId);
  const working = main.find((v) => WORKING.includes(v.status));
  const latest = main[0] ?? data.versions[0];
  const baseForNew = main.find((v) => v.status === "RELEASED") ?? latest;
  const mayStart = (data.perms.edit || data.perms.manage) && p.state === "ACTIVE";
  const canStart = mayStart && !working;
  const variantBase = main.find((v) => v.status === "RELEASED") ?? main.find((v) => !NOT_A_BASE.includes(v.status));
  const changeTab = (t: string) => {
    setTab(t);
    const u = new URL(location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u);
  };
  const pendingSigs = data.signatures.filter((s) => s.status === "REQUESTED").length;
  const openReviews = data.reviews.filter((r) => r.status === "OPEN").length;
  const folder = data.folders.find((f) => f.id === p.folderId);
  const live = useLivePeople([p.id])[p.id];
  const versionLabels = Object.fromEntries(data.versions.map((v) => [v.id, v.label]));

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
            {live?.length ? (
              <Link href={`/projects/${p.id}/v/${live.find((x) => x.mode === "edit")?.versionId ?? live[0].versionId}`} className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success-soft px-2 py-0.5 text-2xs font-medium text-success hover:underline">
                <LiveStack people={live} versions={versionLabels} size={18} /> Live now — join
              </Link>
            ) : null}
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
          <span className="flex items-center gap-2">
          {mayStart && variantBase && (
            <Button onClick={() => setVariantFrom(variantBase)} title={`A customer / configuration variant branched from v${variantBase.label}`}>
              <GitFork /> New variant
            </Button>
          )}
          {working ? (
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
          ) : null}
          </span>
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
            <VersionsTab data={data} onStart={mayStart ? setStartFrom : undefined} onVariant={mayStart ? setVariantFrom : undefined} />
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
      {startFrom && <StartVersionDialog projectId={p.id} parent={startFrom} variant={data.variants.find((x) => x.id === startFrom.variantId) ?? null} onClose={() => setStartFrom(null)} />}
      {variantFrom && <CreateVariantDialog data={data} base={variantFrom} onClose={() => setVariantFrom(null)} />}
    </div>
  );
}

function Count({ n, accent }: { n: number; accent?: boolean }) {
  if (!n) return null;
  return <span className={cn("ml-1 rounded-full px-1.5 text-[10px] font-semibold tabular-nums", accent ? "bg-accent text-white" : "bg-hover text-muted")}>{n}</span>;
}

function StartVersionDialog({ projectId, parent, variant, onClose }: { projectId: string; parent: VersionRow; variant: VariantRow | null; onClose: () => void }) {
  const router = useRouter();
  const [summary, setSummary] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [ticket, setTicket] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const j = await api<{ id: string; label: string; obsoleted: string | null }>(`/api/projects/${projectId}/versions`, { method: "POST", json: { parentId: parent.id, summary, description, ticket: ticket || undefined } });
      toast.success(`Version ${j.label} started${j.obsoleted ? ` — v${j.obsoleted} is now obsolete` : ""}`);
      router.push(`/projects/${projectId}/v/${j.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={variant ? `New version of ${variant.name}` : "Start new version"}
        description={`Copies the drawing of v${parent.label} (${parent.status.toLowerCase().replace("_", " ")}) into a new draft${variant ? ` in the ${variant.code} variant line` : ""}. The source stays unchanged.`}
      >
        <form onSubmit={submit} className="space-y-3">
          {parent.status === "SIGNED" && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-2xs text-warning">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              v{parent.label} is signed and can no longer be changed or taken back. It will be marked obsolete and replaced by the new version.
            </p>
          )}
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

type LineAction = "release" | "withdraw" | "supersede" | "sign" | "recall" | "obsolete";

function VersionsTab({ data, onStart, onVariant }: { data: ProjectData; onStart?: (v: VersionRow) => void; onVariant?: (v: VersionRow) => void }) {
  const [showArchived, setShowArchived] = React.useState(false);
  const [edit, setEdit] = React.useState<VariantRow | null>(null);
  const [run] = useMutation();
  if (!data.versions.length) return <Empty title="No versions">This project has no versions yet.</Empty>;
  const main = data.versions.filter((v) => !v.variantId);
  const active = data.variants.filter((v) => v.state !== "ARCHIVED");
  const archived = data.variants.filter((v) => v.state === "ARCHIVED");
  const lineOf = (variant: VariantRow) => data.versions.filter((v) => v.variantId === variant.id);
  const variantSection = (variant: VariantRow) => {
    const list = lineOf(variant);
    const working = list.find((v) => WORKING.includes(v.status));
    const released = list.find((v) => v.status === "RELEASED");
    const isArchived = variant.state === "ARCHIVED";
    return (
      <Section
        key={variant.id}
        className={cn(isArchived && "opacity-75")}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <GitFork className="size-3.5 text-muted" />
            {variant.name}
            <Badge tone="purple" className="font-mono">
              {variant.code}
            </Badge>
            {isArchived && <Badge>Archived</Badge>}
            {released && <span className="text-2xs font-normal text-muted">released v{released.label}</span>}
          </span>
        }
        description={[variant.customer && `Customer: ${variant.customer}`, `Branched from v${variant.baseLabel}`, `by ${variant.createdBy} ${relTime(variant.createdAt)}`, variant.description].filter(Boolean).join(" · ")}
        actions={
          <>
            {working ? (
              <Button size="xs" variant="primary" asChild>
                <Link href={`/projects/${data.project.id}/v/${working.id}`}>
                  <PenLine /> Open v{working.label}
                </Link>
              </Button>
            ) : onStart && !isArchived && list[0] ? (
              <Button size="xs" onClick={() => onStart(list.find((v) => v.status === "RELEASED") ?? list[0])}>
                <GitBranchPlus /> New version
              </Button>
            ) : null}
            {(data.perms.edit || data.perms.manage) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More actions for variant ${variant.code}`}>
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end" className="w-52">
                  <MenuItem onSelect={() => setEdit(variant)}>
                    <Pencil /> Edit details
                  </MenuItem>
                  {data.perms.manage && (
                    <MenuItem
                      onSelect={() => run(() => api(`/api/variants/${variant.id}`, { method: "PATCH", json: { state: isArchived ? "ACTIVE" : "ARCHIVED" } }), isArchived ? `${variant.name} restored` : `${variant.name} archived`)}
                    >
                      {isArchived ? <ArchiveRestore /> : <Archive />} {isArchived ? "Restore variant" : "Archive variant"}
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      >
        {list.length ? <VersionTable data={data} versions={list} onStart={isArchived ? undefined : onStart} /> : <p className="p-4 text-xs text-muted">No versions in this variant.</p>}
      </Section>
    );
  };
  return (
    <div className="space-y-4">
      <Section
        title={
          <span className="flex items-center gap-2">
            Main line
            {data.variants.length > 0 && <span className="text-2xs font-normal text-muted">the product's standard design — v1, v2, …</span>}
          </span>
        }
        description={data.variants.length === 0 ? "Need a customer-specific change (e.g. an extra emergency stop) without a new product version? Create a variant from a version's menu or with “New variant”." : undefined}
      >
        <VersionTable data={data} versions={main} onStart={onStart} onVariant={onVariant} />
      </Section>
      {active.map(variantSection)}
      {archived.length > 0 && (
        <div>
          <button className="mb-2 text-2xs text-muted hover:text-fg hover:underline" onClick={() => setShowArchived((x) => !x)}>
            {showArchived ? "Hide" : "Show"} {archived.length} archived variant{archived.length === 1 ? "" : "s"}
          </button>
          {showArchived && <div className="space-y-4">{archived.map(variantSection)}</div>}
        </div>
      )}
      {edit && <EditVariantDialog variant={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function VersionTable({ data, versions, onStart, onVariant }: { data: ProjectData; versions: VersionRow[]; onStart?: (v: VersionRow) => void; onVariant?: (v: VersionRow) => void }) {
  const [run] = useMutation();
  const [dlg, setDlg] = React.useState<{ kind: LineAction; v: VersionRow } | null>(null);
  const pid = data.project.id;
  const lineWorking = versions.find((v) => WORKING.includes(v.status));
  const canRelease = (s: string) => (data.policy.signatureRequiredForRelease ? s === "SIGNED" : s === "APPROVED" || s === "SIGNED");
  const signedBy = (id: string) => data.signatures.some((s) => s.versionId === id && s.status === "SIGNED");
  const variantsFrom = (id: string) => data.variants.filter((x) => x.baseVersionId === id);
  const releasedInLine = (id: string) => versions.find((x) => x.status === "RELEASED" && x.id !== id);
  return (
    <>
      <Table>
        <thead>
          <tr>
            <th className="w-28">Version</th>
            <th className="w-36">Status</th>
            <th>Summary</th>
            <th className="w-32">Author</th>
            <th className="w-40">Dates</th>
            <th className="w-44 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const frozen = !WORKING.includes(v.status);
            const pendingSig = data.signatures.some((s) => s.versionId === v.id && s.status === "REQUESTED");
            const signed = signedBy(v.id);
            const branches = variantsFrom(v.id);
            const mayRecall = !signed && ((v.status === "APPROVED" && (data.perms.manage || data.perms.approve)) || (v.status === "IN_REVIEW" && (data.perms.manage || (data.perms.edit && v.createdById === data.me.id))));
            return (
              <tr key={v.id} className="align-top [&>td]:py-2">
                <td>
                  <Link href={`/projects/${pid}/v/${v.id}`} className="font-mono text-xs font-semibold hover:underline">
                    v{v.label}
                  </Link>
                  {v.parentLabel && <p className="text-2xs text-muted">from v{v.parentLabel}</p>}
                  {branches.length > 0 && (
                    <p className="flex items-center gap-1 text-2xs text-muted" title={branches.map((b) => b.name).join(", ")}>
                      <GitFork className="size-3" /> {branches.length} variant{branches.length === 1 ? "" : "s"}
                    </p>
                  )}
                </td>
                <td>
                  <StatusBadge status={v.status} />
                  {pendingSig && <p className="mt-1 text-2xs text-muted">Awaiting signatures{signed ? " · partly signed" : ""}</p>}
                  {["SIGNED", "RELEASED"].includes(v.status) && (
                    <p className="mt-1 flex items-center gap-1 text-2xs text-muted">
                      <Lock className="size-3" /> Changes need a new version
                    </p>
                  )}
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
                  {v.endedAt && ["OBSOLETE", "SUPERSEDED", "WITHDRAWN"].includes(v.status) && <p title={fmtDate(v.endedAt)}>Ended {fmtDate(v.endedAt, false)}</p>}
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
                      <MenuContent align="end" className="w-60">
                        <MenuLabel>v{v.label}</MenuLabel>
                        {data.perms.requestSignatures && v.status === "APPROVED" && (
                          <MenuItem onSelect={() => setDlg({ kind: "sign", v })}>
                            <FileSignature /> Request signatures
                          </MenuItem>
                        )}
                        {data.perms.manage && canRelease(v.status) && (
                          <MenuItem onSelect={() => setDlg({ kind: "release", v })}>
                            <Rocket /> Release
                          </MenuItem>
                        )}
                        {mayRecall && (
                          <MenuItem onSelect={() => setDlg({ kind: "recall", v })}>
                            <RotateCcw /> {v.status === "APPROVED" ? "Take back approval" : "Recall from review"}
                          </MenuItem>
                        )}
                        {onStart && !lineWorking && frozen && (
                          <MenuItem onSelect={() => onStart(v)}>
                            <GitBranchPlus /> {v.status === "SIGNED" ? "Revise as new version (marks this obsolete)" : "Start new version from here"}
                          </MenuItem>
                        )}
                        {onVariant && !v.variantId && !NOT_A_BASE.includes(v.status) && (
                          <MenuItem onSelect={() => onVariant(v)}>
                            <GitFork /> Create variant from here
                          </MenuItem>
                        )}
                        {data.perms.manage && v.status === "RELEASED" && (
                          <MenuItem onSelect={() => setDlg({ kind: "supersede", v })}>
                            <ArchiveX /> Mark superseded
                          </MenuItem>
                        )}
                        {data.perms.manage && ["SIGNED", "RELEASED"].includes(v.status) && (
                          <MenuItem danger onSelect={() => setDlg({ kind: "obsolete", v })}>
                            <Ban /> Mark obsolete
                          </MenuItem>
                        )}
                        {data.perms.manage && ["IN_REVIEW", "APPROVED"].includes(v.status) && !signed && (
                          <MenuItem danger onSelect={() => setDlg({ kind: "withdraw", v })}>
                            <Undo2 /> Withdraw
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
                        {data.perms.export && ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED", "OBSOLETE"].includes(v.status) && (
                          <MenuItem onSelect={() => download(`/api/versions/${v.id}/release.pdf`)}>
                            <FileSignature /> Release PDF with signature record
                          </MenuItem>
                        )}
                        {data.perms.export && ["RELEASED", "SUPERSEDED", "OBSOLETE"].includes(v.status) && (
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
            releasedInLine(dlg.v.id)
              ? `The currently released version of this line (v${releasedInLine(dlg.v.id)!.label}) will be marked superseded. Everyone following this project is notified.`
              : "This becomes the released drawing of record for this line. Everyone following this project is notified."
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
      {dlg?.kind === "recall" && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setDlg(null)}
          title={dlg.v.status === "APPROVED" ? `Take back the approval of v${dlg.v.label}?` : `Recall v${dlg.v.label} from review?`}
          description={
            dlg.v.status === "APPROVED"
              ? "The version returns to draft and can be edited again. Its review is closed as recalled and pending signature requests are cancelled; reviewers are notified. Once anyone has signed, this is no longer possible."
              : "The version returns to draft and can be edited again. The open review is closed as recalled; reviewers are notified. Comments stay on the version."
          }
          confirmLabel={dlg.v.status === "APPROVED" ? "Take back approval" : "Recall to draft"}
          reason
          onConfirm={async (reason) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/recall`, { method: "POST", json: { reason } }), `v${dlg.v.label} is a draft again`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "obsolete" && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Mark v${dlg.v.label} obsolete?`}
          description="Obsolete versions stay in the history with their signatures but must not be used, and cannot be edited. Signed versions are never taken back — make the change in a new version. Starting a new version from a signed one does this automatically."
          confirmLabel="Mark obsolete"
          reason
          onConfirm={async (reason) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/obsolete`, { method: "POST", json: { reason } }), `v${dlg.v.label} is obsolete`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "withdraw" && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Withdraw v${dlg.v.label}?`}
          description="Withdrawn versions stay in the history but must not be used and cannot be edited again (use “Recall” to continue editing instead). Open reviews and signature requests are cancelled."
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
          description="Use this when a released drawing is replaced by another document. Releasing a newer version of the same line does this automatically."
          confirmLabel="Mark superseded"
          reason
          onConfirm={async (reason) => {
            if (await run(() => api(`/api/versions/${dlg.v.id}/supersede`, { method: "POST", json: { reason } }), `v${dlg.v.label} superseded`)) setDlg(null);
          }}
        />
      )}
      {dlg?.kind === "sign" && <RequestSignaturesDialog data={data} v={dlg.v} onClose={() => setDlg(null)} />}
    </>
  );
}

function CreateVariantDialog({ data, base, onClose }: { data: ProjectData; base: VersionRow; onClose: () => void }) {
  const router = useRouter();
  const bases = data.versions.filter((v) => !v.variantId && !NOT_A_BASE.includes(v.status));
  const [baseId, setBaseId] = React.useState(base.id);
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [codeTouched, setCodeTouched] = React.useState(false);
  const [customer, setCustomer] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const b = bases.find((v) => v.id === baseId) ?? base;
  const suggested = (customer || name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8);
  const effCode = (codeTouched ? code : suggested).toUpperCase();
  const taken = data.variants.some((v) => v.code === effCode);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const j = await api<{ version: { id: string; label: string } }>(`/api/projects/${data.project.id}/variants`, { method: "POST", json: { baseVersionId: b.id, code: effCode, name, customer, description } });
      toast.success(`Variant created — version ${j.version.label} started`);
      router.push(`/projects/${data.project.id}/v/${j.version.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New variant"
        description="A variant is a separate line of versions for one customer or configuration (e.g. the standard robot plus an extra emergency stop). It starts as a copy of a main-line version and goes through its own review, signing and release — the main line is not affected."
      >
        <form onSubmit={submit} className="space-y-3">
          <Field label="Based on *">
            <NativeSelect value={baseId} onChange={(e) => setBaseId(e.target.value)} aria-label="Base version">
              {bases.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.label} — {v.status.toLowerCase().replace("_", " ")} — {v.summary.slice(0, 60)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Variant name *">
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Additional emergency stop at loading station" maxLength={120} />
          </Field>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label="Customer">
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. ACME Logistics" maxLength={200} />
            </Field>
            <Field label="Code *" hint={taken ? "Already used" : `Versions: ${b.label}-${effCode || "CODE"}.1`}>
              <Input
                required
                value={effCode}
                onChange={(e) => (setCodeTouched(true), setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 16)))}
                className="font-mono"
                aria-invalid={taken}
              />
            </Field>
          </div>
          <Field label="What is different">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer requirement, order / ECR number, scope of the change" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || !effCode || taken}>
              {busy && <Spinner />} Create & open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditVariantDialog({ variant, onClose }: { variant: VariantRow; onClose: () => void }) {
  const [run, busy] = useMutation();
  const [name, setName] = React.useState(variant.name);
  const [customer, setCustomer] = React.useState(variant.customer);
  const [description, setDescription] = React.useState(variant.description);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Variant ${variant.code}`} description={`Branched from v${variant.baseLabel}. The code is part of version labels and cannot change.`}>
        <div className="space-y-3">
          <Field label="Name *">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Customer">
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={200} />
          </Field>
          <Field label="What is different">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              if (await run(() => api(`/api/variants/${variant.id}`, { method: "PATCH", json: { name, customer, description } }), "Variant updated")) onClose();
            }}
          >
            {busy && <Spinner />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
