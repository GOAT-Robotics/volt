"use client";
import * as React from "react";
import Link from "next/link";
import { UserPlus, Trash2, Plus, Users, Save, Eraser, ScrollText, UserX, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Avatar, Badge, Checkbox, Empty, Spinner, Switch, Table, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { relTime } from "@/lib/utils";
import { ROLES, ROLE_LABEL, type Role } from "@/lib/roles";
import type { WorkspaceSettings } from "@/lib/settings";
import type { Styles } from "@/core/model";
import type { ProjectTemplateContent } from "@/lib/templates";
import { PromptDialog, Section, useMutation } from "@/components/volt/common";
import { StyleTemplatesTab, ProjectTemplatesTab } from "./AdminTemplates";

type Hist = { version: number; action: string; at: string; by: string; note?: string; name?: string };
export type AdminData = {
  meId: string;
  workspaceName: string;
  settings: WorkspaceSettings;
  members: { userId: string; name: string; email: string; roles: Role[]; source: string; disabled: boolean; isGuest: boolean; lastLoginAt: string | null }[];
  groups: { id: string; entraGroupId: string; displayName: string; roles: Role[] }[];
  styleTemplates: { id: string; name: string; version: number; status: string; isDefault: boolean; updatedAt: string; styles: Styles; history: Hist[] }[];
  projectTemplates: { id: string; name: string; description: string; version: number; status: string; isDefault: boolean; updatedAt: string; content: ProjectTemplateContent; seedPages: number; history: Hist[] }[];
  versions: { id: string; label: string }[];
  retention: { autosavesDue: number; projectsDue: number };
  entraEnabled: boolean;
};

const TABS = ["general", "members", "groups", "styles", "templates", "retention"];

export function AdminView({ data, initialTab }: { data: AdminData; initialTab: string }) {
  const [tab, setTab] = React.useState(TABS.includes(initialTab) ? initialTab : "general");
  const change = (t: string) => {
    setTab(t);
    const u = new URL(location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u);
  };
  return (
    <div>
      <PageHeader
        title="Administration"
        description={`Workspace “${data.workspaceName}” — policies, members, templates and retention.`}
        actions={
          <Button asChild>
            <Link href="/admin/audit">
              <ScrollText /> Audit log
            </Link>
          </Button>
        }
      />
      <TabsRoot value={tab} onValueChange={change}>
        <TabsList className="bg-panel px-6">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="groups">Entra groups</TabsTrigger>
          <TabsTrigger value="styles">Style templates</TabsTrigger>
          <TabsTrigger value="templates">Project templates</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
        </TabsList>
        <div className="p-6">
          <TabsContent value="general">
            <GeneralTab data={data} />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab data={data} />
          </TabsContent>
          <TabsContent value="groups">
            <GroupsTab data={data} />
          </TabsContent>
          <TabsContent value="styles">
            <StyleTemplatesTab data={data} />
          </TabsContent>
          <TabsContent value="templates">
            <ProjectTemplatesTab data={data} />
          </TabsContent>
          <TabsContent value="retention">
            <RetentionTab data={data} />
          </TabsContent>
        </div>
      </TabsRoot>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 last:border-0 sm:grid-cols-[1fr_260px] sm:items-center">
      <div>
        <p className="text-xs font-medium">{label}</p>
        {hint && <p className="text-2xs text-muted">{hint}</p>}
      </div>
      <div className="flex justify-start sm:justify-end">{children}</div>
    </div>
  );
}

function Num({ value, onChange, min = 0, max, id, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; id?: string; label: string }) {
  return <Input id={id} aria-label={label} type="number" min={min} max={max} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} className="w-28 text-right tabular-nums" />;
}

function Optional({ value, onChange, label, unit, min = 1 }: { value: number | null; onChange: (v: number | null) => void; label: string; unit: string; min?: number }) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={value !== null} onCheckedChange={(c) => onChange(c ? value ?? 30 : null)} aria-label={`Enable ${label}`} />
      {value !== null ? (
        <>
          <Num value={value} onChange={(n) => onChange(n)} min={min} label={label} />
          <span className="text-2xs text-muted">{unit}</span>
        </>
      ) : (
        <span className="w-36 text-2xs text-muted">Off</span>
      )}
    </div>
  );
}

function GeneralTab({ data }: { data: AdminData }) {
  const [run, busy] = useMutation();
  const [s, setS] = React.useState<WorkspaceSettings>(data.settings);
  const [name, setName] = React.useState(data.workspaceName);
  const up = <K extends keyof WorkspaceSettings>(k: K, v: Partial<WorkspaceSettings[K]> | WorkspaceSettings[K]) =>
    setS((x) => ({ ...x, [k]: typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(x[k] as object), ...(v as object) } : v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings) || name !== data.workspaceName;
  const save = () => run(() => api("/api/admin/settings", { method: "PUT", json: { name, settings: s } }), "Workspace settings saved");
  const a = s.approval;
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-16">
      <Section title="Workspace">
        <Row label="Workspace name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-60" aria-label="Workspace name" />
        </Row>
      </Section>
      <Section title="Access & sessions">
        <Row label="Guest accounts" hint="External (B2B guest) users signing in with Entra ID.">
          <NativeSelect value={s.guestPolicy} onChange={(e) => up("guestPolicy", e.target.value as WorkspaceSettings["guestPolicy"])} className="w-60" aria-label="Guest policy">
            <option value="deny">Deny sign-in</option>
            <option value="reviewOnly">Review only (invited projects)</option>
            <option value="allow">Allow with mapped roles</option>
          </NativeSelect>
        </Row>
        <Row label="Session length" hint="Hours before users must sign in again.">
          <Num value={s.sessionHours} onChange={(n) => up("sessionHours", n)} min={1} label="Session hours" />
        </Row>
        <Row label="Re-authentication for signing" hint="Signatories must have signed in within this many minutes.">
          <Num value={s.signReauthMinutes} onChange={(n) => up("signReauthMinutes", n)} min={1} label="Re-auth minutes" />
        </Row>
      </Section>
      <Section title="Approval policy" description="Project templates can override these per project.">
        <Row label="Minimum approvals" hint="Distinct approvers needed before a version is approved.">
          <Num value={a.minApprovals} onChange={(n) => up("approval", { minApprovals: n })} min={1} label="Minimum approvals" />
        </Row>
        <Row label="Sequential review by default" hint="Approvers decide one after another in the listed order.">
          <Switch checked={a.sequentialDefault} onCheckedChange={(c) => up("approval", { sequentialDefault: c })} aria-label="Sequential by default" />
        </Row>
        <Row label="Allow self-approval" hint="Authors and submitters may approve their own versions.">
          <Switch checked={a.allowSelfApproval} onCheckedChange={(c) => up("approval", { allowSelfApproval: c })} aria-label="Allow self-approval" />
        </Row>
        <Row label="Require all comments resolved" hint="Open comments block completion of a review.">
          <Switch checked={a.requireCommentsResolved} onCheckedChange={(c) => up("approval", { requireCommentsResolved: c })} aria-label="Require comments resolved" />
        </Row>
        <Row label="Approval expiry" hint="Approvals older than this must be given again (checked when the version is opened).">
          <Optional value={a.approvalExpiryDays} onChange={(v) => up("approval", { approvalExpiryDays: v })} label="approval expiry" unit="days" />
        </Row>
        <Row label="Signatures required for release" hint="Approved versions must be fully signed before release.">
          <Switch checked={a.signatureRequiredForRelease} onCheckedChange={(c) => up("approval", { signatureRequiredForRelease: c })} aria-label="Signatures required for release" />
        </Row>
        <Row label="Required signatories" hint="Minimum number of signatories per signature request.">
          <Num value={a.requiredSignatories} onChange={(n) => up("approval", { requiredSignatories: n })} min={0} label="Required signatories" />
        </Row>
        <Row label="Changes to submitted versions" hint="Submitted versions are always frozen; changes go into a new version.">
          <NativeSelect value={a.editSubmitted} onChange={(e) => up("approval", { editSubmitted: e.target.value as "forbid" | "newVersion" })} className="w-60" aria-label="Edit submitted">
            <option value="newVersion">Offer “Start new version”</option>
            <option value="forbid">Forbid until review closes</option>
          </NativeSelect>
        </Row>
      </Section>
      <Section title="Electronic signatures" description="Built-in provider: Ed25519-sealed evidence records (see docs/SIGNING.md).">
        <div className="border-b border-border px-4 py-3">
          <Field label="Signature statement (shown to and recorded for every signatory)">
            <Textarea rows={3} value={s.signature.statement} onChange={(e) => up("signature", { statement: e.target.value })} />
          </Field>
        </div>
        <Row label="Request expiry" hint="Days until an unsigned request expires (0 = never).">
          <Num value={s.signature.expiryDays} onChange={(n) => up("signature", { expiryDays: n })} min={0} label="Signature expiry days" />
        </Row>
      </Section>
      <Section title="Exports">
        <Row label="Viewers can export">
          <Switch checked={s.exports.viewerCanExport} onCheckedChange={(c) => up("exports", { viewerCanExport: c })} aria-label="Viewers can export" />
        </Row>
        <Row label="Guests can export">
          <Switch checked={s.exports.guestCanExport} onCheckedChange={(c) => up("exports", { guestCanExport: c })} aria-label="Guests can export" />
        </Row>
        <Row label="Allowed formats">
          <div className="flex flex-wrap gap-3">
            {["pdf", "svg", "png", "qet", "dxf"].map((f) => (
              <label key={f} className="flex items-center gap-1.5 text-xs uppercase">
                <Checkbox checked={s.exports.formats.includes(f)} onCheckedChange={(c) => up("exports", { formats: c ? [...s.exports.formats, f] : s.exports.formats.filter((x) => x !== f) })} />
                {f}
              </label>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Notifications" description="In-app notifications are always on.">
        <Row label="Email notifications" hint="Requires SMTP_URL on the server.">
          <Switch checked={s.notifications.email} onCheckedChange={(c) => up("notifications", { email: c })} aria-label="Email notifications" />
        </Row>
        <Row label="Microsoft Teams webhook" hint="Incoming webhook URL for a channel (https).">
          <Input value={s.notifications.teamsWebhook ?? ""} onChange={(e) => up("notifications", { teamsWebhook: e.target.value || null })} placeholder="https://…" className="w-60" aria-label="Teams webhook URL" />
        </Row>
      </Section>
      <Section title="Retention">
        <Row label="Archive inactive projects" hint="Used by the retention cleanup.">
          <Optional value={s.retention.archiveAfterDays} onChange={(v) => up("retention", { archiveAfterDays: v })} label="archive after" unit="days" />
        </Row>
        <Row label="Delete autosaves after">
          <Num value={s.retention.deleteAutosavesAfterDays} onChange={(n) => up("retention", { deleteAutosavesAfterDays: n })} min={1} label="Delete autosaves after days" />
        </Row>
        <Row label="Keep audit log" hint="Years (informational; audit events are never deleted by Volt).">
          <Num value={s.retention.keepAuditYears} onChange={(n) => up("retention", { keepAuditYears: n })} min={1} label="Keep audit years" />
        </Row>
      </Section>
      <Section title="Editor & compatibility">
        <Row label="QElectroTech baseline version" hint="Version written into exported .qet files.">
          <Input value={s.qetBaseline} onChange={(e) => up("qetBaseline", e.target.value)} className="w-28 text-right" aria-label="QET baseline" />
        </Row>
        <Row label="Autosave interval" hint="Seconds between editor autosaves.">
          <Num value={s.autosaveSeconds} onChange={(n) => up("autosaveSeconds", n)} min={1} label="Autosave seconds" />
        </Row>
        <Row label="Default version numbering" hint="Pre-selected for new projects.">
          <NativeSelect value={s.versionScheme} onChange={(e) => up("versionScheme", e.target.value as WorkspaceSettings["versionScheme"])} className="w-60" aria-label="Default version scheme">
            <option value="INTEGER">Integer (1, 2, 3)</option>
            <option value="DECIMAL">Decimal (0.1, 0.2)</option>
            <option value="LETTER">Letter (A, B, C)</option>
            <option value="CUSTOM">Custom pattern</option>
          </NativeSelect>
        </Row>
        <Row label="Library: approval required for organization elements">
          <Switch checked={s.library.requireApprovalForOrg} onCheckedChange={(c) => up("library", { requireApprovalForOrg: c })} aria-label="Library approval required" />
        </Row>
      </Section>
      <div className="sticky bottom-3 z-10 flex justify-end gap-2 rounded-lg border border-border bg-panel/95 px-4 py-2.5 shadow-float backdrop-blur">
        {dirty && <span className="mr-auto self-center text-2xs text-warning">Unsaved changes</span>}
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => (setS(data.settings), setName(data.workspaceName))}>
          Discard
        </Button>
        <Button variant="primary" onClick={save} disabled={!dirty || busy}>
          {busy ? <Spinner /> : <Save />} Save settings
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RoleChecks({ roles, onChange, disabled, who }: { roles: Role[]; onChange: (r: Role[]) => void; disabled?: boolean; who: string }) {
  return (
    <>
      {ROLES.map((r) => (
        <td key={r} className="text-center">
          <Checkbox className="mx-auto" checked={roles.includes(r)} disabled={disabled} aria-label={`${ROLE_LABEL[r]} for ${who}`} onCheckedChange={(c) => onChange(c ? [...roles, r] : roles.filter((x) => x !== r))} />
        </td>
      ))}
    </>
  );
}

function RoleHead() {
  return (
    <>
      {ROLES.map((r) => (
        <th key={r} className="w-16 text-center" title={ROLE_LABEL[r]}>
          {r.charAt(0) + r.slice(1).toLowerCase()}
        </th>
      ))}
    </>
  );
}

function MembersTab({ data }: { data: AdminData }) {
  const [run, busy] = useMutation();
  const [adding, setAdding] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [toggle, setToggle] = React.useState<AdminData["members"][number] | null>(null);
  const list = data.members.filter((m) => !q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section
      title="Members"
      description="Roles apply to every project in the workspace. GROUP memberships come from Entra group mappings and are recomputed at sign-in; editing roles here makes them manual."
      actions={
        <>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-44" aria-label="Filter members" />
          <Button size="xs" variant="primary" onClick={() => setAdding(true)}>
            <UserPlus /> Add member
          </Button>
        </>
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <th>User</th>
              <th className="w-20">Source</th>
              <RoleHead />
              <th className="w-24">Last sign-in</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.userId} className={m.disabled ? "opacity-60" : ""}>
                <td>
                  <span className="flex items-center gap-2">
                    <Avatar name={m.name} size={20} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">
                        {m.name} {m.userId === data.meId && <Badge>You</Badge>} {m.isGuest && <Badge tone="warning">Guest</Badge>} {m.disabled && <Badge tone="danger">Disabled</Badge>}
                      </span>
                      <span className="block truncate text-2xs text-muted">{m.email}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <Badge tone={m.source === "GROUP" ? "accent" : "neutral"}>{m.source === "GROUP" ? "Group" : "Manual"}</Badge>
                </td>
                <RoleChecks roles={m.roles} who={m.name} disabled={busy} onChange={(roles) => (roles.length ? run(() => api(`/api/admin/members/${m.userId}`, { method: "PATCH", json: { roles } }), "Roles updated") : undefined)} />
                <td className="text-2xs text-muted">{m.lastLoginAt ? relTime(m.lastLoginAt) : "Never"}</td>
                <td className="text-right">
                  {m.userId !== data.meId && (
                    <Button size="xs" variant={m.disabled ? "secondary" : "danger-ghost"} onClick={() => setToggle(m)}>
                      {m.disabled ? <UserCheck /> : <UserX />} {m.disabled ? "Enable" : "Disable"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {adding && <AddWorkspaceMember onClose={() => setAdding(false)} />}
      {toggle && (
        <PromptDialog
          open
          danger={!toggle.disabled}
          onOpenChange={(o) => !o && setToggle(null)}
          title={toggle.disabled ? `Enable ${toggle.name}?` : `Disable ${toggle.name}?`}
          description={toggle.disabled ? "They can sign in again with their existing roles." : "They can no longer sign in or use the API. Their history (versions, reviews, signatures, audit) is kept."}
          confirmLabel={toggle.disabled ? "Enable" : "Disable user"}
          onConfirm={async () => {
            if (await run(() => api(`/api/admin/members/${toggle.userId}`, { method: "PATCH", json: { disabled: !toggle.disabled } }), toggle.disabled ? "User enabled" : "User disabled")) setToggle(null);
          }}
        />
      )}
    </Section>
  );
}

function AddWorkspaceMember({ onClose }: { onClose: () => void }) {
  const [run, busy] = useMutation();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [roles, setRoles] = React.useState<Role[]>(["DESIGNER"]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add member" description="Pre-creates the account. The person signs in with this email address (Microsoft Entra ID).">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/api/admin/members", { method: "POST", json: { email, name: name || undefined, roles } }), `Added ${email}`)) onClose();
          }}
        >
          <Field label="Email *">
            <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </Field>
          <Field label="Display name" hint="Updated from Entra ID at first sign-in.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-1 text-2xs font-medium text-muted">Roles</legend>
            <div className="grid grid-cols-2 gap-1">
              {ROLES.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover">
                  <Checkbox checked={roles.includes(r)} onCheckedChange={(c) => setRoles((x) => (c ? [...x, r] : x.filter((y) => y !== r)))} />
                  {ROLE_LABEL[r]}
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !roles.length}>
              {busy && <Spinner />} Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupsTab({ data }: { data: AdminData }) {
  const [run, busy] = useMutation();
  const [f, setF] = React.useState({ entraGroupId: "", displayName: "", roles: ["VIEWER"] as Role[] });
  const [del, setDel] = React.useState<AdminData["groups"][number] | null>(null);
  return (
    <div className="space-y-4">
      <Section title="Entra ID group mappings" description={`Members of a mapped group receive its roles at sign-in (the app registration must emit the “groups” claim).${data.entraEnabled ? "" : " Entra ID is not configured on this server yet."}`}>
        {data.groups.length === 0 ? (
          <Empty icon={<Users />} title="No group mappings">Map an Entra security group (object id) to Volt roles below — e.g. “Electrical Engineering” → Designer.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <th>Group</th>
                  <RoleHead />
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <p className="text-xs font-medium">{g.displayName}</p>
                      <p className="font-mono text-2xs text-muted">{g.entraGroupId}</p>
                    </td>
                    <RoleChecks roles={g.roles} who={g.displayName} disabled={busy} onChange={(roles) => (roles.length ? run(() => api(`/api/admin/groups/${g.id}`, { method: "PATCH", json: { roles } }), "Mapping updated") : undefined)} />
                    <td>
                      <Button size="icon-sm" variant="danger-ghost" aria-label={`Remove mapping ${g.displayName}`} onClick={() => setDel(g)}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Section>
      <Section title="Add mapping">
        <form
          className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/api/admin/groups", { method: "POST", json: f }), "Group mapped")) setF({ entraGroupId: "", displayName: "", roles: ["VIEWER"] });
          }}
        >
          <Field label="Group object id">
            <Input required value={f.entraGroupId} onChange={(e) => setF({ ...f, entraGroupId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono" />
          </Field>
          <Field label="Display name">
            <Input required value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder="Electrical Engineering" />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !f.roles.length}>
            <Plus /> Add
          </Button>
          <div className="flex flex-wrap gap-3 sm:col-span-3">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-xs">
                <Checkbox checked={f.roles.includes(r)} onCheckedChange={(c) => setF({ ...f, roles: c ? [...f.roles, r] : f.roles.filter((x) => x !== r) })} />
                {ROLE_LABEL[r]}
              </label>
            ))}
          </div>
        </form>
      </Section>
      {del && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDel(null)}
          title={`Remove mapping “${del.displayName}”?`}
          description="Members lose these roles at their next sign-in (unless they also have manual roles)."
          confirmLabel="Remove"
          onConfirm={async () => {
            if (await run(() => api(`/api/admin/groups/${del.id}`, { method: "DELETE" }), "Mapping removed")) setDel(null);
          }}
        />
      )}
    </div>
  );
}

function RetentionTab({ data }: { data: AdminData }) {
  const [run, busy] = useMutation();
  const [confirm, setConfirm] = React.useState(false);
  const r = data.settings.retention;
  return (
    <div className="max-w-2xl space-y-4">
      <Section title="Retention cleanup" description="Uses the retention settings from the General tab. Every run is recorded in the audit log.">
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 p-4 text-xs">
          <dt>Delete editor autosaves older than {r.deleteAutosavesAfterDays} days</dt>
          <dd className="text-right font-medium tabular-nums">{data.retention.autosavesDue} due</dd>
          <dt>{r.archiveAfterDays ? `Archive projects inactive for ${r.archiveAfterDays} days` : "Archiving inactive projects is off"}</dt>
          <dd className="text-right font-medium tabular-nums">{r.archiveAfterDays ? `${data.retention.projectsDue} due` : "—"}</dd>
          <dt className="text-muted">Versions, reviews, signatures and audit events are never deleted by retention.</dt>
          <dd />
        </dl>
        <div className="flex justify-end border-t border-border px-4 py-3">
          <Button variant="primary" onClick={() => setConfirm(true)} disabled={busy}>
            <Eraser /> Run cleanup now
          </Button>
        </div>
      </Section>
      <PromptDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run retention cleanup?"
        description={`Deletes ${data.retention.autosavesDue} autosave${data.retention.autosavesDue === 1 ? "" : "s"}${r.archiveAfterDays ? ` and archives ${data.retention.projectsDue} project${data.retention.projectsDue === 1 ? "" : "s"}` : ""}.`}
        confirmLabel="Run now"
        onConfirm={async () => {
          const res = await run(() => api<{ autosaves: number; projects: number }>("/api/admin/retention", { method: "POST", json: {} }), (j) => `Deleted ${j.autosaves} autosaves, archived ${j.projects} projects`);
          if (res) setConfirm(false);
        }}
      />
    </div>
  );
}
