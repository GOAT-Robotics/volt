"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Star, Plus, Upload, Folder, FolderOpen, FolderPlus, MoreHorizontal, Clock, Layers, Archive, Search, Pencil, Trash2, ExternalLink, Tag, X, FolderKanban } from "lucide-react";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Empty, Tip } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/fetcher";
import { cn, relTime } from "@/lib/utils";
import { PromptDialog, useMutation } from "@/components/volt/common";
import { NewProjectDialog } from "./NewProjectDialog";
import { ImportQetButton } from "./ImportQet";

export type ProjectRow = {
  id: string;
  name: string;
  number: string | null;
  description: string;
  tags: string[];
  folderId: string | null;
  favorite: boolean;
  updatedAt: string;
  versionCount: number;
  latest: { id: string; label: string; status: string } | null;
  released: { label: string } | null;
  openVersionId: string | null;
};
export type FolderRow = { id: string; name: string; parentId: string | null; count: number };
export type TemplateOption = { id: string; name: string; description: string; isDefault: boolean; requiredFields: string[] };
type Filters = { folder: string | null; tag: string | null; state: "ACTIVE" | "ARCHIVED"; q: string; view: "all" | "favorites" | "recent" };

export function ProjectsView(p: {
  projects: ProjectRow[];
  folders: FolderRow[];
  tags: string[];
  totals: { all: number; favorites: number };
  filters: Filters;
  canCreate: boolean;
  templates: TemplateOption[];
  defaultScheme: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const [newOpen, setNewOpen] = React.useState(false);
  const [q, setQ] = React.useState(p.filters.q);
  const href = React.useCallback(
    (patch: Partial<Filters>) => {
      const f = { ...p.filters, ...patch };
      const sp = new URLSearchParams();
      if (f.folder) sp.set("folder", f.folder);
      if (f.tag) sp.set("tag", f.tag);
      if (f.state !== "ACTIVE") sp.set("state", f.state);
      if (f.q) sp.set("q", f.q);
      if (f.view !== "all") sp.set("view", f.view);
      const s = sp.toString();
      return s ? `${path}?${s}` : path;
    },
    [p.filters, path],
  );
  React.useEffect(() => {
    if (q === p.filters.q) return;
    const t = setTimeout(() => router.replace(href({ q })), 250);
    return () => clearTimeout(t);
  }, [q, p.filters.q, href, router]);

  const folderName = p.filters.folder ? p.folders.find((f) => f.id === p.filters.folder)?.name : null;
  const heading = p.filters.view === "favorites" ? "Favorites" : p.filters.view === "recent" ? "Recent" : folderName ?? "All projects";
  const filtered = !!(p.filters.folder || p.filters.tag || p.filters.q || p.filters.view !== "all");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Projects"
        description="Electrical drawings with versioning, review and release control."
        actions={
          p.canCreate && (
            <>
              <ImportQetButton folders={p.folders} currentFolder={p.filters.folder} />
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                <Plus /> New project
              </Button>
            </>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-panel p-2 md:block" aria-label="Project folders">
          <nav className="space-y-0.5">
            <SideLink href={href({ folder: null, view: "all", tag: null })} active={!p.filters.folder && p.filters.view === "all"} icon={<Layers />} label="All projects" count={p.totals.all} />
            <SideLink href={href({ folder: null, view: "favorites", tag: null })} active={p.filters.view === "favorites"} icon={<Star />} label="Favorites" count={p.totals.favorites} />
            <SideLink href={href({ folder: null, view: "recent", tag: null })} active={p.filters.view === "recent"} icon={<Clock />} label="Recent" />
          </nav>
          <FolderTree folders={p.folders} active={p.filters.folder} href={(id) => href({ folder: id, view: "all" })} canEdit={p.canCreate} />
          {p.tags.length > 0 && (
            <div className="mt-4">
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted">Tags</p>
              <div className="flex flex-wrap gap-1 px-2">
                {p.tags.map((t) => (
                  <Link
                    key={t}
                    href={href({ tag: p.filters.tag === t ? null : t })}
                    className={cn("inline-flex h-5 items-center rounded-full border px-2 text-2xs", p.filters.tag === t ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-hover hover:text-fg")}
                    aria-pressed={p.filters.tag === t}
                  >
                    {t}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
            <h2 className="mr-2 text-sm font-semibold">{heading}</h2>
            {p.filters.tag && (
              <Link href={href({ tag: null })} className="inline-flex h-5 items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 text-2xs text-accent" aria-label={`Remove tag filter ${p.filters.tag}`}>
                <Tag className="size-3" /> {p.filters.tag} <X className="size-3" />
              </Link>
            )}
            <div className="relative ml-auto w-64">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, number, tag…" className="pl-7" aria-label="Filter projects" />
            </div>
            <div className="flex rounded-md border border-border bg-panel-2 p-0.5" role="group" aria-label="Project state">
              {(["ACTIVE", "ARCHIVED"] as const).map((s) => (
                <Link key={s} href={href({ state: s })} aria-pressed={p.filters.state === s} className={cn("flex h-6 items-center gap-1 rounded px-2 text-2xs font-medium", p.filters.state === s ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg")}>
                  {s === "ARCHIVED" && <Archive className="size-3" />}
                  {s === "ACTIVE" ? "Active" : "Archived"}
                </Link>
              ))}
            </div>
          </div>
          {p.projects.length === 0 ? (
            filtered || p.filters.state === "ARCHIVED" ? (
              <Empty icon={<Search />} title={p.filters.state === "ARCHIVED" && !filtered ? "No archived projects" : "No projects match"} action={filtered ? <Button asChild><Link href={href({ folder: null, tag: null, q: "", view: "all" })}>Clear filters</Link></Button> : undefined}>
                {p.filters.state === "ARCHIVED" ? "Projects you archive from their Settings tab appear here." : "Try another folder, tag or search term."}
              </Empty>
            ) : (
              <Empty
                icon={<FolderKanban />}
                title="Create your first project"
                action={
                  p.canCreate ? (
                    <div className="flex gap-2">
                      <ImportQetButton folders={p.folders} currentFolder={null} />
                      <Button variant="primary" onClick={() => setNewOpen(true)}>
                        <Plus /> New project
                      </Button>
                    </div>
                  ) : undefined
                }
              >
                {p.canCreate ? "Start from a blank drawing or a project template, or import an existing QElectroTech .qet file — its compatibility report is kept with the project." : "You haven’t been added to any project yet. Ask a project owner to invite you."}
              </Empty>
            )
          ) : (
            <ProjectList projects={p.projects} folders={p.folders} />
          )}
        </div>
      </div>
      {newOpen && <NewProjectDialog onClose={() => setNewOpen(false)} folders={p.folders} templates={p.templates} currentFolder={p.filters.folder} defaultScheme={p.defaultScheme} />}
    </div>
  );
}

function SideLink({ href, active, icon, label, count }: { href: string; active: boolean; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-xs [&_svg]:size-3.5", active ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-2xs text-muted tabular-nums">{count}</span>}
    </Link>
  );
}

function FolderTree({ folders, active, href, canEdit }: { folders: FolderRow[]; active: string | null; href: (id: string) => string; canEdit: boolean }) {
  const [run] = useMutation();
  const [dlg, setDlg] = React.useState<{ mode: "new" | "rename" | "delete"; folder?: FolderRow; parentId?: string | null } | null>(null);
  const [name, setName] = React.useState("");
  const kids = (pid: string | null) => folders.filter((f) => f.parentId === pid);
  const render = (pid: string | null, depth: number): React.ReactNode =>
    kids(pid).map((f) => (
      <li key={f.id}>
        <div className={cn("group flex h-7 items-center rounded-md pr-1 text-xs", active === f.id ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")} style={{ paddingLeft: 8 + depth * 12 }}>
          <Link href={href(f.id)} className="flex min-w-0 flex-1 items-center gap-2 [&_svg]:size-3.5" aria-current={active === f.id ? "page" : undefined}>
            {active === f.id ? <FolderOpen /> : <Folder />}
            <span className="truncate">{f.name}</span>
            <span className="ml-auto text-2xs text-muted tabular-nums">{f.count || ""}</span>
          </Link>
          {canEdit && (
            <Menu>
              <MenuTrigger asChild>
                <button className="ml-1 rounded p-0.5 text-subtle opacity-0 hover:bg-panel hover:text-fg focus:opacity-100 group-hover:opacity-100" aria-label={`Folder actions for ${f.name}`}>
                  <MoreHorizontal className="size-3.5" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => (setName(""), setDlg({ mode: "new", parentId: f.id }))}>
                  <FolderPlus /> New subfolder
                </MenuItem>
                <MenuItem onSelect={() => (setName(f.name), setDlg({ mode: "rename", folder: f }))}>
                  <Pencil /> Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => setDlg({ mode: "delete", folder: f })}>
                  <Trash2 /> Delete folder
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
        {kids(f.id).length > 0 && <ul>{render(f.id, depth + 1)}</ul>}
      </li>
    ));
  const save = async () => {
    if (!dlg || !name.trim()) return;
    const ok = await run(
      () => (dlg.mode === "new" ? api("/api/folders", { method: "POST", json: { name, parentId: dlg.parentId ?? null } }) : api(`/api/folders/${dlg.folder!.id}`, { method: "PATCH", json: { name } })),
      dlg.mode === "new" ? "Folder created" : "Folder renamed",
    );
    if (ok) setDlg(null);
  };
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-2 pb-1">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted">Folders</p>
        {canEdit && (
          <Tip content="New folder">
            <button onClick={() => (setName(""), setDlg({ mode: "new", parentId: null }))} className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg" aria-label="New folder">
              <FolderPlus className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      {folders.length === 0 ? <p className="px-2 text-2xs text-muted">{canEdit ? "Group projects into folders — create one with +." : "No folders."}</p> : <ul>{render(null, 0)}</ul>}
      {dlg && dlg.mode !== "delete" && (
        <PromptDialog open onOpenChange={(o) => !o && setDlg(null)} title={dlg.mode === "new" ? "New folder" : "Rename folder"} confirmLabel={dlg.mode === "new" ? "Create" : "Rename"} onConfirm={save}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" aria-label="Folder name" maxLength={120} />
        </PromptDialog>
      )}
      {dlg?.mode === "delete" && (
        <PromptDialog
          open
          danger
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Delete folder “${dlg.folder!.name}”?`}
          description="Projects and subfolders inside it move to the parent folder. No project is deleted."
          confirmLabel="Delete folder"
          onConfirm={async () => {
            if (await run(() => api(`/api/folders/${dlg.folder!.id}`, { method: "DELETE" }), "Folder deleted")) setDlg(null);
          }}
        />
      )}
    </div>
  );
}

function ProjectList({ projects, folders }: { projects: ProjectRow[]; folders: FolderRow[] }) {
  const [run] = useMutation();
  const fname = (id: string | null) => (id ? folders.find((f) => f.id === id)?.name : null);
  return (
    <ul className="divide-y divide-border" aria-label="Projects">
      {projects.map((p) => (
        <li key={p.id} className="group flex items-center gap-3 px-6 py-2.5 hover:bg-panel-2">
          <button
            onClick={() => run(() => api(`/api/projects/${p.id}/favorite`, { method: "POST" }))}
            aria-label={p.favorite ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
            aria-pressed={p.favorite}
            className={cn("rounded p-1 hover:bg-hover", p.favorite ? "text-amber-500" : "text-subtle hover:text-fg")}
          >
            <Star className="size-3.5" fill={p.favorite ? "currentColor" : "none"} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link href={`/projects/${p.id}`} className="truncate text-sm font-medium hover:underline">
                {p.name}
              </Link>
              {p.number && <span className="shrink-0 font-mono text-2xs text-muted">{p.number}</span>}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-muted">
              {fname(p.folderId) && (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                  <Folder className="size-3" /> {fname(p.folderId)}
                </span>
              )}
              {p.description && <span className="truncate">{p.description}</span>}
            </div>
          </div>
          <div className="hidden max-w-56 flex-wrap justify-end gap-1 lg:flex">
            {p.tags.slice(0, 4).map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
          <div className="w-44 shrink-0">
            {p.latest ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-2xs font-semibold">v{p.latest.label}</span>
                <StatusBadge status={p.latest.status} />
              </div>
            ) : (
              <span className="text-2xs text-muted">No versions</span>
            )}
            <p className="mt-0.5 text-2xs text-muted">{p.released ? `Released v${p.released.label}` : "Not released yet"}</p>
          </div>
          <span className="hidden w-20 shrink-0 text-right text-2xs text-muted sm:block" title={new Date(p.updatedAt).toLocaleString()}>
            {relTime(p.updatedAt)}
          </span>
          {p.openVersionId && (
            <Button size="xs" variant="ghost" asChild>
              <Link href={`/projects/${p.id}/v/${p.openVersionId}`} aria-label={`Open ${p.name} in the editor`}>
                <ExternalLink /> Open
              </Link>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
