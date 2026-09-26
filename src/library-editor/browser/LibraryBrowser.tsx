"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BadgeCheck, Boxes, Building2, ChevronRight, Component, Download, Folder, FolderOpen, Library, Lock, Plus, Search, Upload, User, Users, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Badge, Checkbox, Empty, Spinner, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, downloadBlob } from "@/lib/utils";
import type { LibItem, LibraryInfo, LibUser } from "../types";
import { PreviewImg, categoryTrail } from "../shared/common";
import { NewElementWizard } from "./NewElementWizard";
import { ImportDialog } from "./ImportDialog";
import { ApprovalsTab, LibrariesTab } from "./Tabs";

type Scope = "all" | "org" | "approved" | "mine" | "shared";
const SCOPES: { id: Scope; label: string; icon: React.ReactNode }[] = [
  { id: "all", label: "All", icon: <Library /> },
  { id: "org", label: "Organization", icon: <Building2 /> },
  { id: "approved", label: "Approved", icon: <BadgeCheck /> },
  { id: "mine", label: "Mine", icon: <User /> },
  { id: "shared", label: "Shared with me", icon: <Users /> },
];

type TreeNode = { name: string; path: string; count: number; children: Map<string, TreeNode> };

function useDebounced<T>(v: T, ms = 220) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function LibraryBrowser({ user }: { user: LibUser }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState(sp.get("tab") ?? "browse");
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [scope, setScope] = useState<Scope>((sp.get("scope") as Scope) ?? "all");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [kind, setKind] = useState<"ELEMENT" | "BLOCK">((sp.get("kind") as "BLOCK") ?? "ELEMENT");
  const [tag, setTag] = useState(sp.get("tag") ?? "");
  const [libraryId, setLibraryId] = useState(sp.get("library") ?? "");
  const [category, setCategory] = useState(sp.get("category") ?? "");
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [libs, setLibs] = useState<LibraryInfo[] | null>(null);
  const [canCreateOrg, setCanCreateOrg] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [wizard, setWizard] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const dq = useDebounced(q);

  // keep URL in sync (shareable filters)
  useEffect(() => {
    const p = new URLSearchParams();
    if (tab !== "browse") p.set("tab", tab);
    if (q) p.set("q", q);
    if (scope !== "all") p.set("scope", scope);
    if (status) p.set("status", status);
    if (kind !== "ELEMENT") p.set("kind", kind);
    if (tag) p.set("tag", tag);
    if (libraryId) p.set("library", libraryId);
    if (category) p.set("category", category);
    const s = p.toString();
    window.history.replaceState(null, "", s ? `/library?${s}` : "/library");
  }, [tab, q, scope, status, kind, tag, libraryId, category]);

  const loadLibs = useCallback(() => {
    api<{ libraries: LibraryInfo[]; canCreateOrg: boolean }>("/api/library/libraries")
      .then((j) => {
        setLibs(j.libraries);
        setCanCreateOrg(j.canCreateOrg);
      })
      .catch(() => setLibs([]));
  }, []);
  useEffect(() => loadLibs(), [loadLibs, reload]);

  useEffect(() => {
    if (!user.isApprover) return;
    api<{ items: LibItem[] }>("/api/library/elements?scope=pending&limit=500")
      .then((j) => setPending(j.items.length))
      .catch(() => {});
  }, [user.isApprover, reload]);

  const PAGE = 240;
  const [total, setTotal] = useState(0);
  const [cats, setCats] = useState<{ path: string; count: number }[] | null>(null);
  const [more, setMore] = useState(0);

  // category tree with counts (server side: the standard library alone has ~9,000 symbols)
  useEffect(() => {
    let off = false;
    const p = new URLSearchParams({ scope, kind });
    if (status) p.set("status", status);
    if (libraryId) p.set("libraryId", libraryId);
    api<{ total: number; categories: { path: string; count: number }[] }>(`/api/library/categories?${p}`)
      .then((j) => !off && setCats(j.categories))
      .catch(() => !off && setCats([]));
    return () => {
      off = true;
    };
  }, [scope, kind, status, libraryId, reload]);

  useEffect(() => setMore(0), [dq, scope, kind, status, tag, libraryId, category, reload]);

  useEffect(() => {
    let off = false;
    if (!more) setItems(null);
    const p = new URLSearchParams({ q: dq, scope, kind, limit: String(PAGE), offset: String(more * PAGE) });
    if (status) p.set("status", status);
    if (tag) p.set("tag", tag);
    if (libraryId) p.set("libraryId", libraryId);
    if (category && category !== "__none") p.set("category", category);
    api<{ items: LibItem[]; truncated: boolean; total?: number }>(`/api/library/elements?${p}`)
      .then((j) => {
        if (off) return;
        setItems((cur) => (more && cur ? [...cur, ...j.items] : j.items));
        setTruncated(j.truncated);
        setTotal(j.total ?? j.items.length);
      })
      .catch((e) => !off && (toast.error((e as Error).message), setItems([])));
    return () => {
      off = true;
    };
  }, [dq, scope, kind, status, tag, libraryId, category, more, reload]);

  const tree = useMemo(() => {
    const root: TreeNode = { name: "", path: "", count: 0, children: new Map() };
    for (const c of cats ?? []) {
      root.count += c.count;
      let n = root;
      const parts = c.path ? c.path.split("/") : ["Uncategorized"];
      parts.forEach((seg, i) => {
        const path = c.path ? parts.slice(0, i + 1).join("/") : "__none";
        let ch = n.children.get(seg);
        if (!ch) n.children.set(seg, (ch = { name: seg, path, count: 0, children: new Map() }));
        ch.count += c.count;
        n = ch;
      });
    }
    return root;
  }, [cats]);

  const shown = useMemo(() => {
    const list = items ?? [];
    if (category === "__none") return list.filter((i) => !i.category);
    return list;
  }, [items, category]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items ?? []) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  }, [items]);
  const categories = useMemo(() => [...new Set((items ?? []).map((i) => i.category).filter(Boolean))].sort(), [items]);

  const toggle = (id: string, on?: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });
  const exportSel = async () => {
    setExporting(true);
    try {
      const ids = [...sel];
      const res = await fetch("/api/library/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, name: "volt_elements" }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Export failed");
      downloadBlob(await res.blob(), "volt_elements.zip");
      toast.success(`Exported ${ids.length} element(s)`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const lib = libs?.find((l) => l.id === libraryId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Component library"
        description="Reusable symbols and blocks. Share them with colleagues or publish them to the whole organization."
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>
              <Upload /> Import
            </Button>
            <Button variant="primary" onClick={() => setWizard(true)}>
              <Plus /> New element
            </Button>
          </>
        }
      />
      <TabsRoot value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="bg-panel px-6">
          <TabsTrigger value="browse">Browse</TabsTrigger>
          {user.isApprover && (
            <TabsTrigger value="approvals" className="flex items-center gap-1.5">
              Approvals {pending > 0 && <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-white">{pending}</span>}
            </TabsTrigger>
          )}
          <TabsTrigger value="libraries">Libraries</TabsTrigger>
        </TabsList>
        {tab === "browse" && (
          <div className="flex min-h-0 flex-1">
            {/* sidebar */}
            <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel" aria-label="Categories">
              <div className="border-b border-border p-3">
                <label className="mb-1 block text-2xs font-medium text-muted" htmlFor="lib-select">
                  Library
                </label>
                <NativeSelect id="lib-select" value={libraryId} onChange={(e) => (setLibraryId(e.target.value), setCategory(""))}>
                  <option value="">All libraries</option>
                  {libs?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.count})
                    </option>
                  ))}
                </NativeSelect>
                {lib && (lib.license || lib.attribution) && (
                  <p className="mt-1.5 text-[10.5px] leading-snug text-subtle">
                    {lib.license && <span className="block">License: {lib.license}</span>}
                    {lib.attribution && <span className="block truncate" title={lib.attribution}>{lib.attribution}</span>}
                  </p>
                )}
              </div>
              <nav className="min-h-0 flex-1 overflow-auto p-2 text-xs">
                <button onClick={() => setCategory("")} className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left", !category ? "bg-hover font-medium" : "text-muted hover:bg-hover")} aria-current={!category ? "true" : undefined}>
                  <Component className="size-3.5" /> <span className="flex-1">Everything</span>
                  <span className="text-2xs text-subtle tabular">{tree.count}</span>
                </button>
                <Tree node={tree} depth={0} active={category} onPick={setCategory} />
              </nav>
            </aside>
            {/* main */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="space-y-2 border-b border-border bg-panel px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-56 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, tag, prefix, manufacturer, part number…" className="h-8 pl-8" aria-label="Search the library" />
                  </div>
                  <div className="flex rounded-md border border-border bg-panel-2 p-0.5" role="radiogroup" aria-label="Kind">
                    {(["ELEMENT", "BLOCK"] as const).map((k) => (
                      <button key={k} role="radio" aria-checked={kind === k} onClick={() => (setKind(k), setSel(new Set()))} className={cn("flex h-6 items-center gap-1 rounded px-2 text-2xs font-medium [&_svg]:size-3", kind === k ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted")}>
                        {k === "ELEMENT" ? <Component /> : <Boxes />} {k === "ELEMENT" ? "Elements" : "Blocks"}
                      </button>
                    ))}
                  </div>
                  <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-40" aria-label="Status">
                    <option value="">Any status</option>
                    <option value="DRAFT">Draft</option>
                    <option value="PUBLISHED">Published</option>
                    <option value="PENDING_APPROVAL">Pending approval</option>
                    <option value="APPROVED">Approved</option>
                    <option value="DEPRECATED">Deprecated</option>
                  </NativeSelect>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {SCOPES.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setScope(c.id)}
                      aria-pressed={scope === c.id}
                      className={cn("flex h-6 items-center gap-1 rounded-full border px-2.5 text-2xs [&_svg]:size-3", scope === c.id ? "border-accent/30 bg-accent-soft text-accent" : "border-border text-muted hover:bg-hover")}
                    >
                      {c.icon}
                      {c.label}
                    </button>
                  ))}
                  {allTags.length > 0 && (
                    <NativeSelect value={tag} onChange={(e) => setTag(e.target.value)} className="ml-1 h-6 w-auto rounded-full text-2xs" aria-label="Tag">
                      <option value="">Any tag</option>
                      {allTags.map(([t, n]) => (
                        <option key={t} value={t}>
                          {t} ({n})
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {tag && !allTags.some(([t]) => t === tag) && (
                    <Badge tone="accent">
                      tag: {tag}
                      <button onClick={() => setTag("")} aria-label="Clear tag">
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  )}
                  <span className="ml-auto text-2xs text-subtle">
                    {items ? `${truncated ? `${shown.length} of ${total.toLocaleString()}` : total.toLocaleString()} ${kind === "BLOCK" ? "block" : "element"}${total === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
              </div>
              {sel.size > 0 && (
                <div className="flex items-center gap-2 border-b border-accent/20 bg-accent-soft px-5 py-1.5 text-xs">
                  <span className="font-medium text-accent">{sel.size} selected</span>
                  <Button size="xs" variant="primary" onClick={exportSel} disabled={exporting || kind === "BLOCK"}>
                    <Download /> Export as .zip
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSel(new Set(shown.map((i) => i.id)))}>
                    Select all {shown.length}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSel(new Set())}>
                    Clear
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto p-5">
                {!items ? (
                  <div className="flex justify-center p-10">
                    <Spinner />
                  </div>
                ) : !shown.length ? (
                  <Empty
                    icon={<FolderOpen />}
                    title={q || tag || status || category ? "No matches" : scope === "shared" ? "Nothing shared with you yet" : "No elements here yet"}
                    action={
                      !q && (
                        <div className="flex gap-2">
                          <Button onClick={() => setImportOpen(true)}>
                            <Upload /> Import
                          </Button>
                          <Button variant="primary" onClick={() => setWizard(true)}>
                            <Plus /> New element
                          </Button>
                        </div>
                      )
                    }
                  >
                    {q || tag || status || category ? "Try another search or clear the filters." : "Create a symbol from a template, import .elmt files, or ask a colleague to share theirs."}
                  </Empty>
                ) : (
                  <>
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-3" aria-label="Library elements">
                      {shown.map((it) => (
                        <Card key={it.id} it={it} selected={sel.has(it.id)} selecting={sel.size > 0} onToggle={(v) => toggle(it.id, v)} onTag={(t) => setTag(t)} />
                      ))}
                    </ul>
                    {truncated && (
                      <div className="mt-5 flex justify-center">
                        <Button variant="secondary" onClick={() => setMore((m) => m + 1)}>
                          Show more ({(total - shown.length).toLocaleString()} left)
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        {tab === "approvals" && user.isApprover && (
          <div className="min-h-0 flex-1 overflow-auto">
            <ApprovalsTab onChanged={() => setReload((x) => x + 1)} />
          </div>
        )}
        {tab === "libraries" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <LibrariesTab
              libraries={libs}
              canCreateOrg={canCreateOrg}
              reload={() => setReload((x) => x + 1)}
              onBrowse={(id) => {
                setLibraryId(id);
                setCategory("");
                setScope("all");
                setTab("browse");
              }}
            />
          </div>
        )}
      </TabsRoot>
      <NewElementWizard open={wizard} onClose={() => setWizard(false)} categories={categories} defaultCategory={category && category !== "__none" ? category : undefined} />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        libraries={libs ?? []}
        onDone={(r) => {
          setReload((x) => x + 1);
          if (r.created || r.updated) {
            setScope("mine");
            setLibraryId(r.libraryId);
            setCategory("");
            setStatus("");
            setQ("");
            setTab("browse");
          }
          router.refresh();
        }}
      />
    </div>
  );
}

function Tree({ node, depth, active, onPick }: { node: TreeNode; depth: number; active: string; onPick: (p: string) => void }) {
  const kids = [...node.children.values()].sort((a, b) => (a.path === "__none" ? 1 : b.path === "__none" ? -1 : a.name.localeCompare(b.name)));
  return (
    <ul role={depth ? "group" : "tree"}>
      {kids.map((c) => (
        <TreeItem key={c.path} node={c} depth={depth} active={active} onPick={onPick} />
      ))}
    </ul>
  );
}

function TreeItem({ node, depth, active, onPick }: { node: TreeNode; depth: number; active: string; onPick: (p: string) => void }) {
  const inPath = active === node.path || active.startsWith(node.path + "/");
  const [open, setOpen] = useState(inPath || depth < 1);
  useEffect(() => {
    if (inPath) setOpen(true);
  }, [inPath]);
  const has = node.children.size > 0;
  return (
    <li role="treeitem" aria-expanded={has ? open : undefined} aria-selected={active === node.path}>
      <div className={cn("flex h-7 items-center rounded-md pr-2", active === node.path ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-hover hover:text-fg")} style={{ paddingLeft: 4 + depth * 12 }}>
        <button aria-label={open ? "Collapse" : "Expand"} className={cn("rounded p-0.5", !has && "invisible")} onClick={() => setOpen(!open)}>
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onPick(node.path)}>
          {node.path === "__none" ? <Lock className="size-3.5 shrink-0 opacity-0" /> : <Folder className="size-3.5 shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        <span className="text-2xs text-subtle tabular">{node.count}</span>
      </div>
      {has && open && <Tree node={node} depth={depth + 1} active={active} onPick={onPick} />}
    </li>
  );
}

function Card({ it, selected, selecting, onToggle, onTag }: { it: LibItem; selected: boolean; selecting: boolean; onToggle: (v: boolean) => void; onTag: (t: string) => void }) {
  return (
    <li className={cn("group relative flex flex-col overflow-hidden rounded-lg border bg-panel transition-shadow hover:shadow-float", selected ? "border-accent ring-1 ring-accent" : "border-border")}>
      <div className={cn("absolute left-2 top-2 z-10 transition-opacity", selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
        <Checkbox checked={selected} onCheckedChange={(v) => onToggle(v === true)} aria-label={`Select ${it.name}`} className="bg-panel" />
      </div>
      <Link href={`/library/${it.id}`} className="flex flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-accent" title={it.description || it.name}>
        <div className="flex h-28 items-center justify-center border-b border-border bg-white p-3 dark:bg-panel-2">
          <PreviewImg id={it.id} rev={it.revision} className="max-h-full max-w-full" alt={it.name} />
        </div>
        <div className="flex flex-1 flex-col gap-1 p-2.5">
          <p className="line-clamp-2 text-xs font-medium leading-snug">{it.name}</p>
          <p className="truncate text-[10.5px] text-subtle">{categoryTrail(it.category)}</p>
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
            {it.prefix && <Badge>{it.prefix}</Badge>}
            <StatusBadge status={it.status} />
            {it.visibility !== "ORG" && <StatusBadge status={it.visibility} />}
            <span className="ml-auto text-[10px] text-subtle tabular">r{it.revision}</span>
          </div>
          <p className="truncate text-[10px] text-subtle">{it.ownerName}</p>
        </div>
      </Link>
      {it.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2.5 pb-2">
          {it.tags.slice(0, 3).map((t) => (
            <button key={t} onClick={() => onTag(t)} className="rounded bg-panel-2 px-1 text-[10px] text-muted hover:text-accent">
              #{t}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
