"use client";
import * as React from "react";
import { Copy, KeyRound, Link2, Mail, Pencil, Plus, Save, Trash2, UserPlus, UserX, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Avatar, Badge, Checkbox, Empty, Spinner, Table } from "@/components/ui/misc";
import { PromptDialog, Section, useMutation } from "@/components/volt/common";
import { api } from "@/lib/fetcher";
import { relTime } from "@/lib/utils";
import { CUSTOM_ROLE_ACTIONS } from "@/lib/roles";
import type { AdminData } from "./AdminView";

type Ext = AdminData["external"][number];
type CRole = AdminData["customRoles"][number];

const PRESETS: { name: string; description: string; actions: string[] }[] = [
  { name: "External designer", description: "Draws and changes the projects they are assigned to; comments; exports.", actions: ["project.view", "project.edit", "project.export", "review.comment", "library.view"] },
  { name: "External reviewer", description: "Reviews and comments on the projects they are assigned to.", actions: ["project.view", "project.export", "review.comment", "review.decide"] },
];

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** end of the chosen day, local time */
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
const ended = (u: Ext) => !!u.accessUntil && new Date(u.accessUntil).getTime() < Date.now();

export function ExternalTab({ data }: { data: AdminData }) {
  const [run, busy] = useMutation();
  const [edit, setEdit] = React.useState<Ext | "new" | null>(null);
  const [remove, setRemove] = React.useState<Ext | null>(null);
  const [link, setLink] = React.useState<{ who: string; url: string; expiresAt: string } | null>(null);
  const [q, setQ] = React.useState("");
  const roles = new Map(data.customRoles.map((r) => [r.id, r]));
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const list = data.external.filter((u) => !q || `${u.name} ${u.email} ${u.company}`.toLowerCase().includes(q.toLowerCase()));

  const sendLink = async (u: Ext, send: boolean) => {
    const r = await run(() => api<{ mailed: boolean; link: string | null; expiresAt: string }>(`/api/admin/external/${u.userId}/link`, { method: "POST", json: { send } }), (x) => (x.mailed ? `Sign-in link emailed to ${u.email}` : undefined));
    if (r?.link) setLink({ who: u.name, url: r.link, expiresAt: r.expiresAt });
  };

  return (
    <div className="space-y-6">
      <Section
        title="External users"
        description={
          <>
            People outside the organization — contractors, customers, suppliers. They sign in with a one-time link sent to their email (no password, no organization account) and see only the projects assigned here. What they may do comes from their custom role.
            {!data.mailConfigured && " Email is not configured (SMTP_URL or SES_FROM_EMAIL): copy the sign-in link and send it yourself."}
          </>
        }
        actions={
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-44" aria-label="Filter external users" />
            <Button size="xs" variant="primary" disabled={!data.customRoles.length} title={data.customRoles.length ? undefined : "Create a custom role first"} onClick={() => setEdit("new")}>
              <UserPlus /> Add external user
            </Button>
          </>
        }
      >
        {!data.external.length ? (
          <Empty icon={<KeyRound />} title="No external users">
            {data.customRoles.length ? "Add a partner, pick their role and the projects they work on. They get an email with a sign-in link." : "Create a custom role below first — it says what external users may do."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <th>User</th>
                  <th className="w-44">Role</th>
                  <th>Projects</th>
                  <th className="w-28">Access until</th>
                  <th className="w-24">Last sign-in</th>
                  <th className="w-56" />
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.userId} className={u.disabled || ended(u) ? "opacity-60" : ""}>
                    <td>
                      <span className="flex items-center gap-2">
                        <Avatar name={u.name} size={20} />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium">
                            {u.name} {u.company && <span className="font-normal text-muted">· {u.company}</span>} {u.disabled && <Badge tone="danger">Disabled</Badge>} {ended(u) && <Badge tone="warning">Ended</Badge>}{" "}
                            {!u.lastLoginAt && u.pendingInvite && <Badge tone="accent">Invited</Badge>}
                          </span>
                          <span className="block truncate text-2xs text-muted">{u.email}</span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <NativeSelect value={u.roleId ?? ""} disabled={busy} aria-label={`Role of ${u.name}`} onChange={(e) => run(() => api(`/api/admin/external/${u.userId}`, { method: "PATCH", json: { roleId: e.target.value } }), "Role changed")}>
                        {!u.roleId && <option value="">— none —</option>}
                        {data.customRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {u.projectIds.length ? u.projectIds.map((id) => <Badge key={id}>{projects.get(id)?.name ?? "?"}</Badge>) : <Badge tone="warning">None</Badge>}
                      </span>
                    </td>
                    <td className="text-2xs text-muted">{u.accessUntil ? new Date(u.accessUntil).toLocaleDateString() : "No end"}</td>
                    <td className="text-2xs text-muted">{u.lastLoginAt ? relTime(u.lastLoginAt) : "Never"}</td>
                    <td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        {!u.disabled && !ended(u) &&
                          (data.mailConfigured ? (
                            <Button size="xs" variant="ghost" disabled={busy} onClick={() => sendLink(u, true)} title="Email a new sign-in link">
                              <Mail /> Send link
                            </Button>
                          ) : null)}
                        {!u.disabled && !ended(u) && (
                          <Button size="xs" variant="ghost" disabled={busy} onClick={() => sendLink(u, false)} title="Create a sign-in link to pass on yourself (recorded in the audit log)">
                            <Link2 /> Copy link
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" onClick={() => setEdit(u)} aria-label={`Edit ${u.name}`}>
                          <Pencil />
                        </Button>
                        <Button size="xs" variant={u.disabled ? "secondary" : "ghost"} disabled={busy} onClick={() => run(() => api(`/api/admin/external/${u.userId}`, { method: "PATCH", json: { disabled: !u.disabled } }), u.disabled ? "Enabled" : "Disabled — open links stop working")} aria-label={u.disabled ? `Enable ${u.name}` : `Disable ${u.name}`}>
                          {u.disabled ? <UserCheck /> : <UserX />}
                        </Button>
                        <Button size="xs" variant="danger-ghost" onClick={() => setRemove(u)} aria-label={`Remove ${u.name}`}>
                          <Trash2 />
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Section>

      <CustomRoles roles={data.customRoles} external={data.external} />

      {edit && <ExternalDialog user={edit === "new" ? null : edit} data={data} roles={roles} onClose={() => setEdit(null)} onLink={setLink} />}
      {remove && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setRemove(null)}
          title={`Remove ${remove.name}?`}
          description="They lose access to this workspace and all its projects at once, and their open sign-in links stop working. Their comments, reviews and audit history are kept."
          confirmLabel="Remove access"
          onConfirm={async () => {
            if (await run(() => api(`/api/admin/external/${remove.userId}`, { method: "DELETE" }), `${remove.name} removed`)) setRemove(null);
          }}
        />
      )}
      {link && <LinkDialog {...link} onClose={() => setLink(null)} />}
    </div>
  );
}

function ExternalDialog({ user, data, roles, onClose, onLink }: { user: Ext | null; data: AdminData; roles: Map<string, CRole>; onClose: () => void; onLink: (l: { who: string; url: string; expiresAt: string }) => void }) {
  const [run, busy] = useMutation();
  const [name, setName] = React.useState(user?.name ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [company, setCompany] = React.useState(user?.company ?? "");
  const [roleId, setRoleId] = React.useState(user?.roleId ?? data.customRoles[0]?.id ?? "");
  const [pids, setPids] = React.useState<string[]>(user?.projectIds ?? []);
  const [until, setUntil] = React.useState(dateOnly(user?.accessUntil ?? null));
  const [send, setSend] = React.useState(data.mailConfigured);
  const [pq, setPq] = React.useState("");
  const role = roles.get(roleId);
  const shown = data.projects.filter((p) => (!p.archived || pids.includes(p.id)) && (!pq || p.name.toLowerCase().includes(pq.toLowerCase())));
  const submit = async () => {
    const json = { name, company, roleId, projectIds: pids, accessUntil: endOfDay(until) };
    if (user) {
      if (await run(() => api(`/api/admin/external/${user.userId}`, { method: "PATCH", json }), "Saved")) onClose();
      return;
    }
    const r = await run(() => api<{ mailed: boolean; link: string | null; expiresAt: string }>("/api/admin/external", { method: "POST", json: { ...json, email, send } }), (x) => (x.mailed ? `Invitation emailed to ${email}` : `${name} added`));
    if (!r) return;
    onClose();
    if (r.link) onLink({ who: name, url: r.link, expiresAt: r.expiresAt });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={user ? `Edit ${user.name}` : "Add external user"} description="Signs in with a one-time email link and sees only the projects ticked here." className="max-w-xl">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name *">
              <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Company">
              <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Acme Automation" />
            </Field>
          </div>
          <Field label="Email *" hint={user ? "The email address cannot be changed — remove the user and add the new address." : "Their sign-in links go to this address."}>
            <Input type="email" required disabled={!!user} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@partner.com" />
          </Field>
          <Field label="Role *" hint={role ? `${role.description || "Custom role"} — ${role.actions.map((a) => CUSTOM_ROLE_ACTIONS.find((x) => x.id === a)?.label ?? a).join(", ")}` : undefined}>
            <NativeSelect required value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {data.customRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset>
            <legend className="mb-1 flex w-full items-center justify-between text-2xs font-medium text-muted">
              <span>Projects * ({pids.length})</span>
              <Input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Filter projects…" className="h-6 w-40 text-2xs" />
            </legend>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
              {shown.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover">
                  <Checkbox checked={pids.includes(p.id)} onCheckedChange={(c) => setPids((x) => (c ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                  {p.name} {p.archived && <Badge>Archived</Badge>}
                </label>
              ))}
              {!shown.length && <p className="px-2 py-1 text-2xs text-subtle">No projects match.</p>}
            </div>
          </fieldset>
          <Field label="Access until" hint="Optional. Access ends at the end of this day, also for open sessions.">
            <Input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} className="w-44" />
          </Field>
          {!user && (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={send} disabled={!data.mailConfigured} onCheckedChange={(c) => setSend(c === true)} />
              Email the invitation with the sign-in link now
              {!data.mailConfigured && <span className="text-2xs text-subtle">(email not configured — you get the link to pass on)</span>}
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !roleId || !pids.length || !name || !email}>
              {busy && <Spinner />} {user ? "Save" : send ? "Add and send invitation" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({ who, url, expiresAt, onClose }: { who: string; url: string; expiresAt: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Sign-in link for ${who}`} description="Send this link to them over a channel you trust. It signs in once, without a password — anyone who has it can use it." className="max-w-xl">
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-2xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"));
              }}
            >
              <Copy /> Copy
            </Button>
          </div>
          <p className="text-2xs text-subtle">Valid until {new Date(expiresAt).toLocaleString()}, once. Creating a new link replaces this one.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomRoles({ roles, external }: { roles: CRole[]; external: Ext[] }) {
  const [run, busy] = useMutation();
  const [drafts, setDrafts] = React.useState<Record<string, CRole>>({});
  const [del, setDel] = React.useState<CRole | null>(null);
  const used = (id: string) => external.filter((u) => u.roleId === id).length;
  const create = (p: { name: string; description: string; actions: string[] }) => {
    let name = p.name;
    for (let i = 2; roles.some((r) => r.name === name); i++) name = `${p.name} ${i}`;
    void run(() => api("/api/admin/roles", { method: "POST", json: { ...p, name } }), `Role “${name}” created`);
  };
  return (
    <Section
      title="Custom roles"
      description="What external users may do in the projects they are assigned to. Workspace administration, creating projects and publishing or approving library parts are never part of a custom role."
      actions={
        <>
          {PRESETS.map((p) => (
            <Button key={p.name} size="xs" variant="secondary" disabled={busy} onClick={() => create(p)}>
              <Plus /> {p.name}
            </Button>
          ))}
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => create({ name: "New role", description: "", actions: ["project.view"] })}>
            <Plus /> Empty role
          </Button>
        </>
      }
    >
      {!roles.length ? (
        <Empty icon={<KeyRound />} title="No custom roles">
          Start from “External designer” or “External reviewer” and adjust it.
        </Empty>
      ) : (
        <div className="divide-y divide-border">
          {roles.map((r0) => {
            const r = drafts[r0.id] ?? r0;
            const dirty = !!drafts[r0.id];
            const set = (p: Partial<CRole>) => setDrafts((d) => ({ ...d, [r0.id]: { ...r, ...p } }));
            return (
              <div key={r0.id} className="space-y-2 p-3">
                <div className="flex items-center gap-2">
                  <Input value={r.name} onChange={(e) => set({ name: e.target.value })} className="w-56 font-medium" aria-label="Role name" />
                  <Input value={r.description} onChange={(e) => set({ description: e.target.value })} placeholder="Description" className="flex-1" aria-label="Role description" />
                  <Badge>{used(r0.id)} user{used(r0.id) === 1 ? "" : "s"}</Badge>
                  <Button
                    size="xs"
                    variant="primary"
                    disabled={!dirty || busy || !r.name.trim()}
                    onClick={async () => {
                      if (await run(() => api(`/api/admin/roles/${r0.id}`, { method: "PATCH", json: { name: r.name, description: r.description, actions: r.actions } }), "Role saved"))
                        setDrafts(({ [r0.id]: _, ...d }) => d);
                    }}
                  >
                    <Save /> Save
                  </Button>
                  <Button size="xs" variant="danger-ghost" disabled={busy || used(r0.id) > 0} title={used(r0.id) ? "In use — give its users another role first" : "Delete role"} onClick={() => setDel(r0)} aria-label={`Delete ${r0.name}`}>
                    <Trash2 />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                  {CUSTOM_ROLE_ACTIONS.map((a) => (
                    <label key={a.id} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-hover" title={a.hint}>
                      <Checkbox
                        className="mt-0.5"
                        checked={r.actions.includes(a.id)}
                        disabled={a.id === "project.view"}
                        onCheckedChange={(c) => set({ actions: c ? [...r.actions, a.id] : r.actions.filter((x) => x !== a.id) })}
                      />
                      <span>
                        <span className="block text-xs">{a.label}</span>
                        {a.hint && <span className="block text-2xs text-subtle">{a.hint}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {del && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDel(null)}
          title={`Delete role “${del.name}”?`}
          description="Nobody has this role. This cannot be undone."
          confirmLabel="Delete role"
          onConfirm={async () => {
            if (await run(() => api(`/api/admin/roles/${del.id}`, { method: "DELETE" }), "Role deleted")) setDel(null);
          }}
        />
      )}
    </Section>
  );
}
