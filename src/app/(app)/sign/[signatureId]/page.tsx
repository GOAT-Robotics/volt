import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, ShieldCheck, Lock, CheckCircle2, XCircle, Clock } from "lucide-react";
import { requireCtx, loadProject, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { parseSettings } from "@/lib/settings";
import { loadSignature, reauthOk, signBlocker } from "@/lib/signing/service";
import { PageHeader } from "@/components/shell/AppShell";
import { StatusBadge } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/volt/common";
import { signIn, signOut, ENTRA_ENABLED } from "@/auth";
import { fmtDate } from "@/lib/utils";
import { SignForm } from "./SignForm";

export const metadata: Metadata = { title: "Sign" };

export default async function SignPage({ params }: { params: Promise<{ signatureId: string }> }) {
  const { signatureId } = await params;
  const ctx = await requireCtx();
  let s;
  try {
    s = await loadSignature(signatureId);
  } catch (e) {
    if (e instanceof HttpError) notFound();
    throw e;
  }
  const mine = s.signatoryId === ctx.user.id;
  if (!mine) {
    // others with project access may look at the request, never sign it
    try {
      const { can } = await loadProject(ctx, s.version.projectId);
      if (!can("project.view")) notFound();
    } catch {
      notFound();
    }
  }
  const v = s.version;
  const ws = await db.workspace.findUnique({ where: { id: v.project.workspaceId } });
  const settings = parseSettings(ws?.settings);
  const blocker = await signBlocker(s, ctx);
  const fresh = reauthOk(ctx);
  const round = await db.signature.findMany({ where: { versionId: v.id, batch: s.batch ?? "-" }, orderBy: { order: "asc" } });
  const names = new Map((await db.user.findMany({ where: { id: { in: round.map((r) => r.signatoryId).concat(s.requestedById) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const user = await db.user.findUnique({ where: { id: ctx.user.id }, select: { entraOid: true } });
  const cb = `/sign/${s.id}`;

  async function reauth() {
    "use server";
    if (ENTRA_ENABLED && user?.entraOid) {
      await signIn("microsoft-entra-id", { redirectTo: cb }, { prompt: "login" });
    } else {
      await signOut({ redirectTo: `/login?callbackUrl=${encodeURIComponent(cb)}&reauth=1` });
    }
  }

  const minsAgo = ctx.authTime ? Math.floor((Date.now() - ctx.authTime) / 60000) : null;

  return (
    <div>
      <PageHeader
        breadcrumb={
          <span>
            <Link href="/reviews" className="hover:text-fg hover:underline">
              My reviews
            </Link>{" "}
            / Signature
          </span>
        }
        title={`Sign ${v.project.name} v${v.label}`}
        description={s.purpose}
        actions={<StatusBadge status={s.status} />}
      />
      <div className="mx-auto grid max-w-5xl gap-5 p-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="text-xs font-semibold">What you are signing</h2>
            <dl className="mt-3 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted">Project</dt>
              <dd>
                <Link href={`/projects/${v.projectId}`} className="font-medium hover:underline">
                  {v.project.name}
                </Link>
                {v.project.number && <span className="ml-1 font-mono text-2xs text-muted">{v.project.number}</span>}
              </dd>
              <dt className="text-muted">Version</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono font-semibold">v{v.label}</span> <StatusBadge status={v.status} />
              </dd>
              <dt className="text-muted">Summary</dt>
              <dd>{v.summary || "—"}</dd>
              <dt className="text-muted">Approved</dt>
              <dd>{fmtDate(v.approvedAt)}</dd>
              <dt className="text-muted">Purpose</dt>
              <dd>{s.purpose}</dd>
              <dt className="text-muted">Requested by</dt>
              <dd>
                {names.get(s.requestedById) ?? "—"} · {fmtDate(s.createdAt)}
              </dd>
              {s.expiresAt && (
                <>
                  <dt className="text-muted">Expires</dt>
                  <dd>{fmtDate(s.expiresAt)}</dd>
                </>
              )}
              <dt className="text-muted">Document SHA-256</dt>
              <dd>
                <Mono>{s.docHash}</Mono>
              </dd>
              <dt className="text-muted">Drawing PDF SHA-256</dt>
              <dd>
                <Mono>{s.pdfHash}</Mono>
              </dd>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild>
                <a href={`/api/versions/${v.id}/canonical.pdf?inline`} target="_blank" rel="noreferrer">
                  <FileText /> View drawing PDF
                </a>
              </Button>
              <Button variant="ghost" asChild>
                <Link href={`/projects/${v.projectId}/v/${v.id}`}>Open in editor</Link>
              </Button>
            </div>
            <p className="mt-2 text-2xs text-muted">The PDF is regenerated deterministically from the frozen version; its SHA-256 must equal the value above. The server re-checks both hashes when you sign.</p>
          </section>
          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="text-xs font-semibold">Signing order</h2>
            <ol className="mt-2 space-y-1.5">
              {round.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs">
                  <span className="w-5 text-2xs tabular-nums text-muted">{r.order + 1}.</span>
                  {r.status === "SIGNED" ? <CheckCircle2 className="size-3.5 text-success" /> : r.status === "REQUESTED" ? <Clock className="size-3.5 text-muted" /> : <XCircle className="size-3.5 text-danger" />}
                  <span className={r.id === s.id ? "font-semibold" : ""}>{names.get(r.signatoryId) ?? "—"}</span>
                  <StatusBadge status={r.status} />
                  {r.signedAt && <span className="text-2xs text-muted">{fmtDate(r.signedAt)}</span>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="space-y-4">
          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold">
              <ShieldCheck className="size-3.5 text-accent" /> Signature statement
            </h2>
            <blockquote className="mt-2 border-l-2 border-accent pl-3 text-xs leading-relaxed">{settings.signature.statement}</blockquote>
            <p className="mt-3 text-2xs text-muted">
              Volt records your identity, authentication time, IP address, browser, the statement and both hashes, and seals this evidence with the workspace key. This is an application-level electronic signature record.
            </p>
          </section>
          {!mine ? (
            <p className="rounded-lg border border-border bg-panel-2 p-4 text-xs text-muted">This signature was requested from {names.get(s.signatoryId) ?? "another person"}. Only they can sign it.</p>
          ) : blocker ? (
            <p className="rounded-lg border border-border bg-panel-2 p-4 text-xs text-muted" role="status">
              {blocker}
              {s.declineReason ? ` (${s.declineReason})` : ""}
            </p>
          ) : !fresh ? (
            <section className="rounded-lg border border-warning/30 bg-warning-soft p-4">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold">
                <Lock className="size-3.5" /> Confirm it’s you
              </h2>
              <p className="mt-1 text-xs">
                Signing requires a sign-in within the last {settings.signReauthMinutes === 1 ? "minute" : `${settings.signReauthMinutes} minutes`}
                {minsAgo !== null ? ` — you signed in ${minsAgo === 1 ? "1 minute" : `${minsAgo} minutes`} ago` : ""}. You’ll come straight back here.
              </p>
              <form action={reauth} className="mt-3">
                <Button type="submit" variant="primary">
                  <Lock /> Re-authenticate to sign
                </Button>
              </form>
            </section>
          ) : (
            <SignForm signatureId={s.id} fullName={ctx.user.name} projectId={v.projectId} />
          )}
        </aside>
      </div>
    </div>
  );
}
