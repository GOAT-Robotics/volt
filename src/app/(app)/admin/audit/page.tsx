import type { Metadata } from "next";
import Link from "next/link";
import { Download, ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { db, J } from "@/lib/db";
import { isAdmin } from "@/lib/access";
import { auditWhere } from "@/lib/auditquery";
import { AUDIT_LABELS } from "@/lib/audit";
import { EXTRA_AUDIT_LABELS } from "@/lib/constants";
import { auditLabel, describeAudit } from "@/lib/describe";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Avatar, Empty, Table } from "@/components/ui/misc";
import { Forbidden } from "@/components/volt/common";
import { fmtDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Audit log" };

type SP = { type?: string; user?: string; project?: string; from?: string; to?: string; page?: string };
const PAGE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx();
  if (!isAdmin(ctx)) return <Forbidden title="Administrators only">The audit log is available to workspace administrators.</Forbidden>;
  const sp = await searchParams;
  const params = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page") as [string, string][]);
  const where = auditWhere(ctx.workspace.id, params);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [total, rows, users, projects] = await Promise.all([
    db.auditEvent.count({ where }),
    db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, include: { actor: { select: { name: true, email: true } } } }),
    db.user.findMany({ where: { memberships: { some: { workspaceId: ctx.workspace.id } } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.project.findMany({ where: { workspaceId: ctx.workspace.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const types = Object.entries({ ...AUDIT_LABELS, ...EXTRA_AUDIT_LABELS }).sort((a, b) => a[1].localeCompare(b[1]));
  const qs = (patch: Record<string, string | number | null>) => {
    const u = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? u.delete(k) : u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every sign-in, change, review decision, signature, export and administrative action."
        actions={
          <Button asChild>
            <a href={`/api/admin/audit${qs({ format: "csv" })}`}>
              <Download /> Export CSV
            </a>
          </Button>
        }
      />
      <div className="p-6">
        <form method="get" className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-border bg-panel p-3 md:grid-cols-6">
          <Field label="Event">
            <NativeSelect name="type" defaultValue={sp.type ?? ""}>
              <option value="">All events</option>
              <option value="version.">All version events</option>
              <option value="review.">All review decisions</option>
              <option value="signature.">All signature events</option>
              <option value="admin.">All admin events</option>
              {types.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="User">
            <NativeSelect name="user" defaultValue={sp.user ?? ""}>
              <option value="">Anyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Project">
            <NativeSelect name="project" defaultValue={sp.project ?? ""}>
              <option value="">Any project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="From">
            <Input type="date" name="from" defaultValue={sp.from ?? ""} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={sp.to ?? ""} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" variant="primary">
              Apply
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/admin/audit">Reset</Link>
            </Button>
          </div>
        </form>
        <div className="overflow-hidden rounded-lg border border-border bg-panel">
          {rows.length === 0 ? (
            <Empty icon={<ScrollText />} title="No events">No audit events match these filters.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className="w-44">Time</th>
                  <th className="w-44">User</th>
                  <th className="w-44">Event</th>
                  <th>Details</th>
                  <th className="w-44">Project</th>
                  <th className="w-28">IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const data = J.parse<Record<string, unknown>>(r.data, {});
                  return (
                    <tr key={r.id} className="align-top [&>td]:py-2">
                      <td className="text-2xs tabular-nums text-muted">{fmtDate(r.createdAt)}</td>
                      <td>
                        {r.actor ? (
                          <span className="flex items-center gap-1.5 text-xs">
                            <Avatar name={r.actor.name} size={18} /> <span className="truncate">{r.actor.name}</span>
                          </span>
                        ) : (
                          <span className="text-2xs text-muted">System</span>
                        )}
                      </td>
                      <td className="text-xs font-medium">{auditLabel(r.type)}</td>
                      <td className="max-w-md text-2xs text-muted">
                        <span className="break-words">{describeAudit(r.type, data)}</span>
                      </td>
                      <td className="text-xs">
                        {r.projectId ? (
                          projectName.has(r.projectId) ? (
                            <Link href={`/projects/${r.projectId}?tab=activity`} className="hover:underline">
                              {projectName.get(r.projectId)}
                            </Link>
                          ) : (
                            <span className="text-2xs text-muted">Deleted project</span>
                          )
                        ) : (
                          <span className="text-2xs text-muted">—</span>
                        )}
                      </td>
                      <td className="font-mono text-2xs text-muted">{r.ip ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
        <nav className="mt-3 flex items-center justify-between text-2xs text-muted" aria-label="Pagination">
          <span>
            {total.toLocaleString()} event{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <span className="flex gap-1">
            <Button size="xs" asChild={page > 1} disabled={page <= 1}>
              {page > 1 ? (
                <Link href={qs({ page: page - 1 })}>
                  <ChevronLeft /> Newer
                </Link>
              ) : (
                <span>
                  <ChevronLeft /> Newer
                </span>
              )}
            </Button>
            <Button size="xs" asChild={page < pages} disabled={page >= pages}>
              {page < pages ? (
                <Link href={qs({ page: page + 1 })}>
                  Older <ChevronRight />
                </Link>
              ) : (
                <span>
                  Older <ChevronRight />
                </span>
              )}
            </Button>
          </span>
        </nav>
      </div>
    </div>
  );
}
