import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Search as SearchIcon, FolderKanban, Cpu, CircleDot, Type, FileText, Spline, ChevronRight } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { db, J } from "@/lib/db";
import { projectScope } from "@/lib/access";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Empty } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { VERSION_STATUSES } from "@/core/model";
import { relTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Search" };

type SP = { q?: string; status?: string; author?: string; reviewer?: string; from?: string; to?: string; state?: string; kind?: string; scope?: string };

const KINDS = [
  { id: "ELEMENT", label: "Components", icon: Cpu },
  { id: "PIN", label: "Pins", icon: CircleDot },
  { id: "LABEL", label: "Labels & text", icon: Type },
  { id: "PAGE", label: "Pages", icon: FileText },
  { id: "WIRE", label: "Wires", icon: Spline },
] as const;
const STATES = [
  { id: "", label: "Any" },
  { id: "in-review", label: "In review" },
  { id: "approved", label: "Approved (not signed)" },
  { id: "awaiting-signature", label: "Awaiting signature" },
  { id: "signed", label: "Signed" },
  { id: "released", label: "Released" },
  { id: "unreleased", label: "Never released" },
];

function stateWhere(s: string | undefined): Prisma.VersionWhereInput {
  switch (s) {
    case "in-review":
      return { status: "IN_REVIEW" };
    case "approved":
      return { status: "APPROVED" };
    case "awaiting-signature":
      return { status: "APPROVED", signatures: { some: { status: "REQUESTED" } } };
    case "signed":
      return { signatures: { some: { status: "SIGNED" } } };
    case "released":
      return { status: "RELEASED" };
    case "unreleased":
      return { releasedAt: null };
  }
  return {};
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requireCtx();
  const q = (sp.q ?? "").trim();
  const scope = sp.scope === "all" ? "all" : "latest";
  const kind = KINDS.some((k) => k.id === sp.kind) ? sp.kind : undefined;
  const status = (VERSION_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const from = sp.from ? new Date(sp.from) : null;
  const to = sp.to ? new Date(new Date(sp.to).getTime() + 86400_000 - 1) : null;
  const hasFilter = !!(q || status || sp.author || sp.reviewer || from || to || sp.state || kind);

  const people = await db.user.findMany({ where: { disabled: false, memberships: { some: { workspaceId: ctx.workspace.id } } }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 });

  type Hit = { kind: string; text: string; pageId: string | null; refId: string | null };
  type VGroup = { id: string; label: string; status: string; updatedAt: Date; hits: Hit[]; pageTitles: Map<string, string> };
  type PGroup = { id: string; name: string; number: string | null; tags: string[]; projectMatch: boolean; versions: VGroup[] };
  const groups = new Map<string, PGroup>();
  let truncated = false;

  if (hasFilter) {
    const vWhere: Prisma.VersionWhereInput = {
      project: projectScope(ctx),
      ...(status ? { status } : {}),
      ...(sp.author ? { createdById: sp.author } : {}),
      ...(sp.reviewer ? { reviews: { some: { assignments: { some: { OR: [{ userId: sp.reviewer }, { decidedById: sp.reviewer }] } } } } } : {}),
      ...(from || to ? { updatedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...stateWhere(sp.state),
    };
    let versions = await db.version.findMany({ where: vWhere, select: { id: true, label: true, status: true, seq: true, updatedAt: true, projectId: true, project: { select: { id: true, name: true, number: true, tags: true, description: true } } }, orderBy: [{ projectId: "asc" }, { seq: "desc" }] });
    if (scope === "latest") {
      const seenP = new Set<string>();
      versions = versions.filter((v) => (seenP.has(v.projectId) ? false : (seenP.add(v.projectId), true)));
    }
    const vmap = new Map(versions.map((v) => [v.id, v]));
    const ensure = (v: (typeof versions)[number]) => {
      let g = groups.get(v.projectId);
      if (!g) {
        g = { id: v.project.id, name: v.project.name, number: v.project.number, tags: J.parse<string[]>(v.project.tags, []), projectMatch: false, versions: [] };
        groups.set(v.projectId, g);
      }
      let vg = g.versions.find((x) => x.id === v.id);
      if (!vg) {
        vg = { id: v.id, label: v.label, status: v.status, updatedAt: v.updatedAt, hits: [], pageTitles: new Map() };
        g.versions.push(vg);
      }
      return { g, vg };
    };
    if (q) {
      const ql = q.toLowerCase();
      for (const v of versions) {
        const p = v.project;
        if (`${p.name} ${p.number ?? ""} ${p.description} ${p.tags}`.toLowerCase().includes(ql)) ensure(v).g.projectMatch = true;
      }
      const ids = versions.map((v) => v.id);
      const LIMIT = 400;
      const rows: { versionId: string; kind: string; text: string; pageId: string | null; refId: string | null }[] = [];
      for (let i = 0; i < ids.length && rows.length < LIMIT; i += 500) {
        rows.push(...(await db.searchEntry.findMany({ where: { versionId: { in: ids.slice(i, i + 500) }, text: { contains: q }, ...(kind ? { kind } : {}) }, select: { versionId: true, kind: true, text: true, pageId: true, refId: true }, take: LIMIT - rows.length + 1 })));
      }
      truncated = rows.length > LIMIT;
      for (const r of rows.slice(0, LIMIT)) {
        const v = vmap.get(r.versionId);
        if (v) ensure(v).vg.hits.push(r);
      }
      // page titles for context
      const pageRows = await db.searchEntry.findMany({ where: { versionId: { in: [...new Set(rows.map((r) => r.versionId))] }, kind: "PAGE" }, select: { versionId: true, pageId: true, text: true } });
      for (const pr of pageRows) {
        const v = vmap.get(pr.versionId);
        if (v && pr.pageId) groups.get(v.projectId)?.versions.find((x) => x.id === v.id)?.pageTitles.set(pr.pageId, pr.text);
      }
    } else {
      for (const v of versions.slice(0, 200)) ensure(v);
      truncated = versions.length > 200;
    }
  }
  const results = [...groups.values()].sort((a, b) => b.versions.reduce((n, v) => n + v.hits.length, 0) - a.versions.reduce((n, v) => n + v.hits.length, 0) || a.name.localeCompare(b.name));
  const hitCount = results.reduce((n, g) => n + g.versions.reduce((m, v) => m + v.hits.length, 0), 0);
  const kindMeta = (k: string) => KINDS.find((x) => x.id === k) ?? KINDS[0];
  const deepLink = (pid: string, vid: string, h: Hit) => {
    const sp2 = new URLSearchParams();
    if (h.pageId) sp2.set("page", h.pageId);
    if (h.refId && h.kind !== "PAGE") sp2.set("el", h.refId);
    const s = sp2.toString();
    return `/projects/${pid}/v/${vid}${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <PageHeader title="Search" description="Find projects, components, pins, wire numbers, labels and pages across every version you can access." />
      <div className="mx-auto max-w-6xl p-6">
        <form action="/search" method="get" className="rounded-lg border border-border bg-panel p-4" role="search">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
              <Input name="q" defaultValue={q} placeholder="e.g. K1, -Q3, 24V, motor, X1:5" className="h-8 pl-8 text-sm" aria-label="Search text" autoFocus={!q} />
            </div>
            <Button type="submit" variant="primary" size="md">
              Search
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
            <Field label="Kind">
              <NativeSelect name="kind" defaultValue={kind ?? ""}>
                <option value="">All kinds</option>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Version status">
              <NativeSelect name="status" defaultValue={status ?? ""}>
                <option value="">Any status</option>
                {VERSION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ")}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Approval / signature">
              <NativeSelect name="state" defaultValue={sp.state ?? ""}>
                {STATES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Author">
              <NativeSelect name="author" defaultValue={sp.author ?? ""}>
                <option value="">Anyone</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Reviewer">
              <NativeSelect name="reviewer" defaultValue={sp.reviewer ?? ""}>
                <option value="">Anyone</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Changed from">
              <Input type="date" name="from" defaultValue={sp.from ?? ""} />
            </Field>
            <Field label="Changed to">
              <Input type="date" name="to" defaultValue={sp.to ?? ""} />
            </Field>
            <Field label="Versions">
              <NativeSelect name="scope" defaultValue={scope}>
                <option value="latest">Latest per project</option>
                <option value="all">All versions</option>
              </NativeSelect>
            </Field>
          </div>
        </form>

        <div className="mt-5">
          {!hasFilter ? (
            <Empty icon={<SearchIcon />} title="Search your drawings">
              Type a component reference, pin, wire number or text, or pick filters such as “Awaiting signature” to list matching versions. Results link straight to the element in the editor.
            </Empty>
          ) : results.length === 0 ? (
            <Empty icon={<SearchIcon />} title="No results">
              Nothing matches{q ? ` “${q}”` : ""} with these filters. Try “All versions”, a different kind, or fewer filters.
            </Empty>
          ) : (
            <>
              <p className="mb-2 text-2xs text-muted" role="status">
                {q ? `${hitCount}${truncated ? "+" : ""} match${hitCount === 1 ? "" : "es"} in ` : ""}
                {results.length} project{results.length === 1 ? "" : "s"}
                {truncated && " — showing the first results; refine your search to narrow it down"}
              </p>
              <div className="space-y-3">
                {results.map((g) => (
                  <section key={g.id} className="rounded-lg border border-border bg-panel">
                    <header className="flex items-center gap-2 border-b border-border px-4 py-2">
                      <FolderKanban className="size-3.5 text-muted" />
                      <Link href={`/projects/${g.id}`} className="text-xs font-semibold hover:underline">
                        {g.name}
                      </Link>
                      {g.number && <span className="font-mono text-2xs text-muted">{g.number}</span>}
                      {g.projectMatch && <Badge tone="accent">Project match</Badge>}
                      {g.tags.slice(0, 3).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </header>
                    {g.versions.map((v) => (
                      <div key={v.id} className="border-b border-border last:border-0">
                        <div className="flex items-center gap-2 px-4 py-1.5">
                          <Link href={`/projects/${g.id}/v/${v.id}`} className="font-mono text-2xs font-semibold hover:underline">
                            v{v.label}
                          </Link>
                          <StatusBadge status={v.status} />
                          <span className="text-2xs text-muted">updated {relTime(v.updatedAt)}</span>
                          {v.hits.length > 0 && <span className="ml-auto text-2xs text-muted">{v.hits.length} match{v.hits.length === 1 ? "" : "es"}</span>}
                        </div>
                        {v.hits.length > 0 && (
                          <ul className="pb-1.5">
                            {v.hits.slice(0, 30).map((h, i) => {
                              const K = kindMeta(h.kind);
                              return (
                                <li key={i}>
                                  <Link href={deepLink(g.id, v.id, h)} className="group flex items-center gap-2 px-4 py-1 pl-8 text-xs hover:bg-hover">
                                    <K.icon className="size-3.5 shrink-0 text-muted" aria-label={K.label} />
                                    <Highlight text={h.text} q={q} />
                                    {h.pageId && v.pageTitles.get(h.pageId) && h.kind !== "PAGE" && <span className="shrink-0 text-2xs text-muted">on {v.pageTitles.get(h.pageId)}</span>}
                                    <ChevronRight className="ml-auto size-3 text-subtle opacity-0 group-hover:opacity-100" />
                                  </Link>
                                </li>
                              );
                            })}
                            {v.hits.length > 30 && <li className="px-4 py-1 pl-8 text-2xs text-muted">+{v.hits.length - 30} more in this version</li>}
                          </ul>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const t = text.length > 140 ? text.slice(0, 137) + "…" : text;
  if (!q) return <span className="truncate">{t}</span>;
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <span className="truncate">{t}</span>;
  return (
    <span className="truncate">
      {t.slice(0, i)}
      <mark className="rounded-sm bg-warning-soft px-0.5 font-medium text-fg">{t.slice(i, i + q.length)}</mark>
      {t.slice(i + q.length)}
    </span>
  );
}
