import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardCheck, FileSignature, Send, History, AlertCircle, Clock, Users } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/shell/AppShell";
import { StatusBadge } from "@/components/ui/status";
import { Badge, Empty } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/volt/common";
import { fmtDate, relTime, cn } from "@/lib/utils";

export const metadata: Metadata = { title: "My reviews" };

export default async function ReviewsPage() {
  const ctx = await requireCtx();
  const me = ctx.user.id;
  const groups = ctx.user.groups.length ? ctx.user.groups : ["-"];
  const now = new Date();
  await db.signature.updateMany({ where: { signatoryId: me, status: "REQUESTED", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });

  const [pending, sigs, submitted, decided] = await Promise.all([
    db.reviewAssignment.findMany({
      where: {
        decision: "PENDING",
        review: { status: "OPEN", version: { status: "IN_REVIEW" } },
        // group assignments only count in workspaces the user belongs to
        OR: [{ userId: me }, { groupId: { in: groups }, review: { version: { project: { workspaceId: { in: ctx.workspaces.map((w) => w.id) } } } } }],
      },
      include: { review: { include: { assignments: true, version: { omit: { doc: true }, include: { project: true } } } } },
      orderBy: { review: { createdAt: "asc" } },
    }),
    db.signature.findMany({ where: { signatoryId: me, status: "REQUESTED" }, include: { version: { omit: { doc: true }, include: { project: true } } }, orderBy: { createdAt: "asc" } }),
    db.review.findMany({ where: { submittedById: me }, include: { assignments: true, version: { omit: { doc: true }, include: { project: true } } }, orderBy: { createdAt: "desc" }, take: 25 }),
    db.reviewAssignment.findMany({ where: { decidedById: me }, include: { review: { include: { version: { omit: { doc: true }, include: { project: true } } } } }, orderBy: { decidedAt: "desc" }, take: 20 }),
  ]);
  // signatures still waiting before mine, per version (one query)
  const open = sigs.length ? await db.signature.findMany({ where: { versionId: { in: [...new Set(sigs.map((s) => s.versionId))] }, status: "REQUESTED" }, select: { versionId: true, order: true } }) : [];
  const earlierSigs = new Map<string, number>(sigs.map((s) => [s.id, open.filter((o) => o.versionId === s.versionId && o.order < s.order).length]));
  const submitterIds = [...new Set(pending.map((a) => a.review.submittedById))];
  const names = new Map((await db.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  // dedupe (user + group assignment on the same review)
  const seen = new Set<string>();
  const todo = pending.filter((a) => (seen.has(a.reviewId) ? false : (seen.add(a.reviewId), true)));
  const total = todo.length + sigs.length;

  return (
    <div>
      <PageHeader title="My reviews" description={total ? `${total} item${total === 1 ? "" : "s"} waiting for you` : "Nothing is waiting for you right now."} />
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <Section title={<span className="flex items-center gap-1.5"><ClipboardCheck className="size-3.5" /> Reviews assigned to me</span>} description="Directly or through one of your Entra groups.">
          {todo.length === 0 ? (
            <Empty title="No reviews waiting">When someone submits a version with you (or your group) as reviewer, it shows up here and in your notifications.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {todo.map((a) => {
                const r = a.review;
                const v = r.version;
                const pendApprovers = r.assignments.filter((x) => x.canApprove && x.decision === "PENDING");
                const minOrder = pendApprovers.length ? Math.min(...pendApprovers.map((x) => x.order)) : 0;
                const waiting = r.sequential && a.canApprove && a.order > minOrder;
                const overdue = r.dueDate && r.dueDate < now;
                return (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{v.project.name}</span>
                        <span className="font-mono text-2xs font-semibold">v{v.label}</span>
                        {a.groupId && (
                          <Badge>
                            <Users className="size-3" /> {a.groupName}
                          </Badge>
                        )}
                        {!a.canApprove && <Badge>Advisory</Badge>}
                        {waiting && <Badge tone="neutral">Waiting for earlier reviewers</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-2xs text-muted">
                        {v.summary} · submitted by {names.get(r.submittedById) ?? "someone"} {relTime(r.createdAt)}
                      </p>
                    </div>
                    {r.dueDate && (
                      <span className={cn("flex items-center gap-1 text-2xs", overdue ? "font-medium text-danger" : "text-muted")}>
                        {overdue ? <AlertCircle className="size-3" /> : <Clock className="size-3" />}
                        {overdue ? "Overdue " : "Due "}
                        {fmtDate(r.dueDate, false)}
                      </span>
                    )}
                    <Button size="xs" variant={waiting ? "secondary" : "primary"} asChild>
                      <Link href={`/projects/${v.projectId}/v/${v.id}`}>{waiting ? "Preview" : "Review"}</Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={<span className="flex items-center gap-1.5"><FileSignature className="size-3.5" /> Signature requests</span>}>
          {sigs.length === 0 ? (
            <Empty title="No signatures requested">Approved versions that need your electronic signature appear here.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {sigs.map((s) => {
                const blocked = (earlierSigs.get(s.id) ?? 0) > 0;
                return (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{s.version.project.name}</span>
                        <span className="font-mono text-2xs font-semibold">v{s.version.label}</span>
                        {blocked && <Badge>Waiting for earlier signatories</Badge>}
                      </p>
                      <p className="mt-0.5 text-2xs text-muted">
                        {s.purpose} · requested {relTime(s.createdAt)}
                        {s.expiresAt && ` · expires ${fmtDate(s.expiresAt, false)}`}
                      </p>
                    </div>
                    <Button size="xs" variant={blocked ? "secondary" : "primary"} asChild>
                      <Link href={`/sign/${s.id}`}>{blocked ? "View" : "Sign"}</Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <div className="grid gap-5 lg:grid-cols-2">
          <Section title={<span className="flex items-center gap-1.5"><Send className="size-3.5" /> Submitted by me</span>}>
            {submitted.length === 0 ? (
              <Empty title="Nothing submitted yet">Submit a working version from the editor to start a review.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {submitted.map((r) => {
                  const done = r.assignments.filter((x) => x.decision !== "PENDING").length;
                  return (
                    <li key={r.id} className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Link href={`/projects/${r.version.projectId}?tab=reviews`} className="truncate text-xs font-medium hover:underline">
                          {r.version.project.name}
                        </Link>
                        <span className="font-mono text-2xs font-semibold">v{r.version.label}</span>
                        <span className="ml-auto">
                          <StatusBadge status={r.version.status} />
                        </span>
                      </div>
                      <p className="mt-0.5 text-2xs text-muted">
                        {done}/{r.assignments.length} decided · {relTime(r.createdAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
          <Section title={<span className="flex items-center gap-1.5"><History className="size-3.5" /> Recently decided</span>}>
            {decided.length === 0 ? (
              <Empty title="No decisions yet">Your approvals, rejections and change requests are listed here.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {decided.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Link href={`/projects/${a.review.version.projectId}/v/${a.review.versionId}`} className="truncate text-xs font-medium hover:underline">
                        {a.review.version.project.name}
                      </Link>
                      <span className="font-mono text-2xs font-semibold">v{a.review.version.label}</span>
                      <span className="ml-auto">
                        <StatusBadge status={a.decision} />
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-2xs text-muted">
                      {a.decidedAt ? fmtDate(a.decidedAt) : ""}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
