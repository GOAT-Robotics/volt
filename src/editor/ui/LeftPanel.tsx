"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Library, Files, Search, ChevronRight, Upload, Boxes, Building2, User, BadgeCheck, FolderOpen, PanelLeftClose, MoreHorizontal, ExternalLink, RefreshCw, GripVertical } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tip, Badge, Spinner, Empty } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import type { ElementDef } from "@/core/model";
import { symbolThumb } from "../thumb";
import { loadLibraryDef, type LibItem } from "../defs-client";
import { reorderPages } from "./PageTabs";
import { runCommand } from "./commands";
import { emptySel } from "@/core/ops";
import { parseElmt } from "@/core/qet/elmt";

const PANEL_MIN = 220, PANEL_MAX = 480;

export function LeftPanel() {
  const panel = useEditor((s) => s.panels.left);
  const [w, setW] = useState(272);
  const set = (left: typeof panel) => {
    const s = useEditor.getState();
    s.set("panels", { ...s.panels, left: s.panels.left === left ? null : left });
  };
  useEffect(() => {
    const f = () => set("outline");
    window.addEventListener("volt:focus-search", f);
    return () => window.removeEventListener("volt:focus-search", f);
  });
  const tabs = [
    { id: "library", icon: <Library />, label: "Library" },
    { id: "pages", icon: <Files />, label: "Pages" },
    { id: "outline", icon: <Search />, label: "Find in drawing" },
  ] as const;
  return (
    <div className="flex shrink-0">
      <nav className="flex w-11 flex-col items-center gap-1 border-r border-border bg-panel py-2" aria-label="Side panels">
        {tabs.map((t) => (
          <Tip key={t.id} content={t.label} side="right">
            <Button variant="tool" size="icon" active={panel === t.id} aria-pressed={panel === t.id} aria-label={t.label} onClick={() => set(t.id)}>
              {t.icon}
            </Button>
          </Tip>
        ))}
      </nav>
      {panel && (
        <aside className="relative flex flex-col border-r border-border bg-panel" style={{ width: w }}>
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <h2 className="text-xs font-semibold">{tabs.find((t) => t.id === panel)?.label}</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Collapse panel" onClick={() => set(panel)}>
              <PanelLeftClose />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {panel === "library" && <LibraryPanel />}
            {panel === "pages" && <PagesPanel />}
            {panel === "outline" && <OutlinePanel />}
          </div>
          <Resizer onResize={(dx) => setW((x) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, x + dx)))} side="right" />
        </aside>
      )}
    </div>
  );
}

export function Resizer({ onResize, side }: { onResize: (dx: number) => void; side: "left" | "right" }) {
  const last = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn("absolute top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/40", side === "right" ? "-right-[3px]" : "-left-[3px]")}
      onPointerDown={(e) => {
        last.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return;
        const dx = e.clientX - last.current;
        last.current = e.clientX;
        onResize(side === "right" ? dx : -dx);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Library                                                              */
/* ------------------------------------------------------------------ */

type Scope = "project" | "all" | "org" | "mine" | "approved";

function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function LibraryPanel() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [kind, setKind] = useState<"ELEMENT" | "BLOCK">("ELEMENT");
  const dq = useDebounced(q);
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const defs = useEditor((s) => s.doc.defs);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const fileRef = useRef<HTMLInputElement>(null);

  const [cats, setCats] = useState<{ path: string; count: number }[] | null>(null);
  useEffect(() => {
    if (scope === "project" || dq.trim()) return;
    let off = false;
    setErr(null);
    setCats(null);
    fetch(`/api/library/categories?${new URLSearchParams({ scope, kind })}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Library unavailable"))))
      .then((j: { categories: { path: string; count: number }[] }) => !off && setCats(j.categories))
      .catch((e) => !off && setErr(e.message));
    return () => {
      off = true;
    };
  }, [dq, scope, kind, reload]);
  const tree = useMemo(() => buildCatTree(cats ?? []), [cats]);

  useEffect(() => {
    if (scope === "project" || !dq.trim()) return;
    let off = false;
    setErr(null);
    setItems(null);
    const params = new URLSearchParams({ q: dq, scope, kind, limit: "300" });
    fetch(`/api/library/elements?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Library unavailable"))))
      .then((j: { items: LibItem[] }) => !off && setItems(j.items))
      .catch((e) => !off && setErr(e.message));
    return () => {
      off = true;
    };
  }, [dq, scope, kind, reload]);

  const projectDefs = useMemo(() => {
    const t = dq.trim().toLowerCase();
    return Object.values(defs)
      .filter((d) => d.name !== "volt_junction")
      .filter((d) => !t || `${d.name} ${Object.values(d.names).join(" ")} ${d.category} ${d.prefix}`.toLowerCase().includes(t))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [defs, dq]);

  const grouped = useMemo(() => {
    const m = new Map<string, LibItem[]>();
    for (const it of items ?? []) {
      const k = it.category || "Uncategorized";
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const pickDef = (def: ElementDef) => {
    if (!editable) return ui.toast("This version is read-only — start a new version to edit.");
    ui.engine.current?.pendingDefs.set(def.id, def);
    useEditor.getState().setTool("place", { kind: "element", defId: def.id, rot: 0, mirror: false });
  };
  const pickLib = async (it: LibItem) => {
    if (it.kind === "BLOCK") {
      if (!editable) return;
      useEditor.getState().setTool("place", { kind: "block", blockId: it.id, name: it.name });
      return;
    }
    try {
      pickDef(await loadLibraryDef(it));
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    }
  };

  const importFiles = async (files: FileList | File[] | null) => {
    const all = [...(files ?? [])]; // copy first: clearing the input empties its live FileList
    if (fileRef.current) fileRef.current.value = ""; // choosing the same file again must fire onChange
    if (!all.length) return;
    const list = all.filter((f) => /\.(elmt|zip)$/i.test(f.name));
    if (!list.length) return ui.toast(all.some((f) => /\.qet$/i.test(f.name)) ? "That is a project (.qet); open it from Projects → Import .qet" : "Choose QElectroTech element files (.elmt) or a .zip of them", { tone: "error" });
    const fd = new FormData();
    for (const f of list) fd.append("files", f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    const res = await fetch("/api/library/import", { method: "POST", body: fd });
    const j = (await res.json().catch(() => ({}))) as { error?: string; created?: number; updated?: number; skipped?: number; errors?: string[] };
    if (!res.ok) return ui.toast(j.error ?? `Import failed (${res.status})`, { tone: "error" });
    const n = (x?: number) => x ?? 0;
    const parts = [
      n(j.created) && `${j.created} imported`,
      n(j.updated) && `${j.updated} updated`,
      n(j.skipped) && `${j.skipped} already in your library`,
      j.errors?.length && `${j.errors.length} could not be read: ${j.errors[0]}`,
    ].filter(Boolean);
    ui.toast(parts.join(" · ") || "Nothing imported", { tone: j.errors?.length && !n(j.created) && !n(j.updated) ? "error" : undefined });
    setScope("mine");
    // show what arrived: a single element is searched by name
    if (list.length === 1 && /\.elmt$/i.test(list[0].name) && !j.errors?.length) {
      const xml = await list[0].text();
      const name = (/<name lang="en">([^<]+)<\/name>/.exec(xml) ?? /<name lang="[^"]*">([^<]+)<\/name>/.exec(xml))?.[1];
      if (name) setQ(name);
    }
    setReload((x) => x + 1);
  };

  const chips: { id: Scope; label: string; icon: React.ReactNode }[] = [
    { id: "all", label: "All", icon: <Library /> },
    { id: "project", label: "In project", icon: <FolderOpen /> },
    { id: "org", label: "Organization", icon: <Building2 /> },
    { id: "approved", label: "Approved", icon: <BadgeCheck /> },
    { id: "mine", label: "Mine", icon: <User /> },
  ];

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="space-y-2 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-subtle" />
          <Input placeholder="Search name, tag, prefix…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-6" aria-label="Search library" />
        </div>
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => (
            <button
              key={c.id}
              onClick={() => setScope(c.id)}
              className={cn("flex h-5 items-center gap-1 rounded-full border px-2 text-2xs [&_svg]:size-2.5", scope === c.id ? "border-accent/30 bg-accent-soft text-accent" : "border-border text-muted hover:bg-hover")}
              aria-pressed={scope === c.id}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>
        {scope !== "project" && (
          <div className="flex items-center justify-between">
            <div className="flex rounded-md border border-border p-0.5 text-2xs">
              {(["ELEMENT", "BLOCK"] as const).map((k) => (
                <button key={k} onClick={() => setKind(k)} className={cn("rounded px-2 py-0.5", kind === k ? "bg-hover font-medium text-fg" : "text-subtle")}>
                  {k === "ELEMENT" ? "Elements" : "Blocks"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              {kind === "BLOCK" && <BlockModeSelect />}
              <Tip content="Refresh">
                <Button variant="ghost" size="icon-sm" onClick={() => setReload((x) => x + 1)} aria-label="Refresh library">
                  <RefreshCw />
                </Button>
              </Tip>
              <Tip content="Import .elmt files or a .zip into your library (or drop them here)">
                <Button variant="ghost" size="icon-sm" onClick={() => fileRef.current?.click()} aria-label="Import elements">
                  <Upload />
                </Button>
              </Tip>
              <input ref={fileRef} type="file" accept=".elmt,.zip" multiple hidden onChange={(e) => importFiles(e.target.files)} />
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {scope === "project" ? (
          projectDefs.length ? (
            <div className="grid grid-cols-3 gap-1">
              {projectDefs.map((d) => (
                <DefTile key={d.id} def={d} onPick={() => pickDef(d)} />
              ))}
            </div>
          ) : (
            <Empty icon={<FolderOpen />} title="No elements yet">
              Elements you place are embedded in the project and listed here.
            </Empty>
          )
        ) : err ? (
          <Empty title="Library unavailable">{err}</Empty>
        ) : !dq.trim() ? (
          !cats ? (
            <div className="flex justify-center p-6 text-subtle">
              <Spinner />
            </div>
          ) : !cats.length ? (
            <Empty icon={kind === "BLOCK" ? <Boxes /> : <Library />} title={kind === "BLOCK" ? "No blocks yet" : "No elements yet"}>
              {kind === "BLOCK" ? "Select components on the canvas and choose “Create reusable block”." : "Import elements or create one in the element editor."}
            </Empty>
          ) : (
            <CatTree nodes={tree} scope={scope} kind={kind} onPick={pickLib} projectDefs={defs} depth={0} />
          )
        ) : !items ? (
          <div className="flex justify-center p-6 text-subtle">
            <Spinner />
          </div>
        ) : !items.length ? (
          <Empty icon={kind === "BLOCK" ? <Boxes /> : <Library />} title={q ? "No matches" : kind === "BLOCK" ? "No blocks yet" : "No elements yet"}>
            {q ? `Nothing matches “${q}” in ${kind === "BLOCK" ? "blocks" : "elements"}.` : kind === "BLOCK" ? "Select components on the canvas and choose “Create reusable block”." : "Import elements or create one in the element editor."}
          </Empty>
        ) : (
          grouped.map(([cat, list]) => <Category key={cat} name={cat} items={list} onPick={pickLib} defaultOpen={grouped.length < 6 || !!q} projectDefs={defs} />)
        )}
      </div>
    </div>
  );
}

function DefTile({ def, onPick }: { def: ElementDef; onPick: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => setSrc(symbolThumb(def, 56)), [def]);
  return (
    <button
      onClick={onPick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-volt-def", def.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={def.name}
      className="group flex flex-col items-center gap-1 rounded-md border border-transparent p-1.5 hover:border-border hover:bg-panel-2"
    >
      <div className="flex size-12 items-center justify-center rounded bg-white">{src && <img src={src} alt="" className="size-12" />}</div>
      <span className="line-clamp-2 w-full text-center text-[10px] leading-tight text-muted group-hover:text-fg">{def.names.en ?? def.name}</span>
    </button>
  );
}

function Category({
  name,
  items: given,
  onPick,
  defaultOpen,
  projectDefs,
  count,
  lazy,
  children,
  depth = 0,
}: {
  name: string;
  items?: LibItem[];
  onPick: (i: LibItem) => void;
  defaultOpen: boolean;
  projectDefs: Record<string, ElementDef>;
  count?: number;
  lazy?: { path: string; scope: string; kind: string; direct: number };
  children?: React.ReactNode;
  depth?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const [loaded, setLoaded] = useState<LibItem[] | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!open || !lazy || !lazy.direct || loaded || started.current) return;
    started.current = true;
    const p = new URLSearchParams({ scope: lazy.scope, kind: lazy.kind, category: lazy.path, exact: "1", limit: "600" });
    fetch(`/api/library/elements?${p}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j: { items: LibItem[] }) => setLoaded(j.items))
      .catch(() => setLoaded([]));
  }, [open, lazy, loaded]);
  const items = given ?? loaded ?? [];
  const ui = useEditorUI();
  const inProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of Object.values(projectDefs)) if (d.source?.libraryElementId) m.set(d.source.libraryElementId, d.source.revision ?? 0);
    return m;
  }, [projectDefs]);
  return (
    <div className={cn(depth === 0 && "mb-0.5")}>
      <button onClick={() => setOpen(!open)} className="flex h-6 w-full items-center gap-1 rounded px-1 text-2xs font-medium text-muted hover:bg-hover" style={{ paddingLeft: 4 + depth * 10 }} aria-expanded={open}>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{name.replace(/^\d+_/, "").replace(/\/\d+_/g, " / ")}</span>
        <span className="ml-auto text-subtle tabular">{count ?? items.length}</span>
      </button>
      {open && children}
      {open && lazy && lazy.direct > 0 && !loaded && (
        <div className="flex justify-center py-2 text-subtle">
          <Spinner />
        </div>
      )}
      {open && items.length > 0 && (
        <div className="grid grid-cols-3 gap-1 pl-1" style={{ paddingLeft: 4 + depth * 10 }}>
          {items.map((it) => {
            const rev = inProject.get(it.id);
            const outdated = rev !== undefined && rev < it.revision;
            return (
              <div key={it.id} className="group relative">
                <button
                  onClick={() => onPick(it)}
                  onMouseEnter={() => it.kind === "ELEMENT" && loadLibraryDef(it).then((d) => ui.engine.current?.pendingDefs.set(d.id, d)).catch(() => {})}
                  draggable
                  onDragStart={(e) => {
                    if (it.kind === "BLOCK") e.dataTransfer.setData("application/x-volt-block", it.id);
                    else e.dataTransfer.setData("application/x-volt-def", `lib:${it.id}@${it.revision}`);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={`${it.name}${it.description ? ` — ${it.description}` : ""}\n${it.libraryName ?? ""} · rev ${it.revision}${it.ownerName ? ` · ${it.ownerName}` : ""}`}
                  className="flex w-full flex-col items-center gap-1 rounded-md border border-transparent p-1.5 hover:border-border hover:bg-panel-2"
                >
                  <div className="relative flex size-12 items-center justify-center rounded bg-white">
                    <img src={`/api/library/elements/${it.id}/preview.svg?rev=${it.revision}`} alt="" loading="lazy" className="max-h-12 max-w-12" />
                    {it.status === "APPROVED" && <BadgeCheck className="absolute -right-1 -top-1 size-3 rounded-full bg-panel text-success" />}
                    {it.kind === "BLOCK" && <Boxes className="absolute -left-1 -top-1 size-3 rounded bg-panel text-accent" />}
                  </div>
                  <span className="line-clamp-2 w-full text-center text-[10px] leading-tight text-muted">{it.name}</span>
                </button>
                {outdated && (
                  <Badge tone="warning" className="absolute left-0.5 top-0.5 !h-3.5 !px-1 !text-[9px]">
                    update
                  </Badge>
                )}
                <Menu>
                  <MenuTrigger asChild>
                    <button className="absolute right-0.5 top-0.5 rounded p-0.5 text-subtle opacity-0 hover:bg-hover group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`${it.name} options`}>
                      <MoreHorizontal className="size-3" />
                    </button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => window.open(`/library/${it.id}`, "_blank")}>
                      <ExternalLink /> Open in element editor
                    </MenuItem>
                    {outdated && (
                      <MenuItem onSelect={() => updateInstances(it, ui)}>
                        <RefreshCw /> Update project instances to rev {it.revision}
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function updateInstances(it: LibItem, ui: ReturnType<typeof useEditorUI>) {
  const def = await loadLibraryDef(it);
  const s = useEditor.getState();
  let n = 0;
  s.apply(`Update ${it.name} to rev ${it.revision}`, (d) => {
    const old = Object.values(d.defs).filter((x) => x.source?.libraryElementId === it.id && x.id !== def.id);
    d.defs[def.id] = def;
    const oldIds = new Set(old.map((o) => o.id));
    for (const p of d.pages)
      for (const e of p.elements)
        if (oldIds.has(e.defId)) {
          e.defId = def.id;
          n++;
        }
    // wires to pins that disappeared become dangling
    const pinIds = new Set(def.pins.map((p) => p.id));
    for (const p of d.pages)
      for (const w of p.wires)
        for (const k of ["a", "b"] as const) {
          const end = w[k];
          if (end.k === "pin" && p.elements.find((e) => e.id === end.el)?.defId === def.id && !pinIds.has(end.pin)) w[k] = { k: "free" };
        }
    for (const o of old) delete d.defs[o.id];
  });
  ui.toast(`Updated ${n} instance${n === 1 ? "" : "s"}`, { undo: true });
}

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

function PagesPanel() {
  const pages = useEditor((s) => s.doc.pages);
  const pageId = useEditor((s) => s.pageId);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const sorted = [...pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Pages">
        {sorted.map((p, i) => (
          <li
            key={p.id}
            role="option"
            aria-selected={p.id === pageId}
            draggable={editable}
            onDragStart={() => setDrag(p.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (!drag || drag === p.id) return;
              const from = sorted.findIndex((x) => x.id === drag);
              const steps = i - from;
              useEditor.getState().apply("Reorder pages", (d) => {
                for (let k = 0; k < Math.abs(steps); k++) reorderPages(d, drag, steps > 0 ? 1 : -1);
              });
              setDrag(null);
            }}
            onClick={() => useEditor.getState().setPage(p.id)}
            className={cn("group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs", p.id === pageId ? "bg-accent-soft text-accent" : "hover:bg-hover")}
          >
            {editable && <GripVertical className="size-3 shrink-0 cursor-grab text-subtle opacity-0 group-hover:opacity-100" />}
            <span className="w-5 text-right text-2xs text-subtle tabular">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
            <span className="text-2xs text-subtle tabular">{p.elements.length}</span>
          </li>
        ))}
      </ul>
      {editable && (
        <div className="border-t border-border p-2">
          <Button size="sm" className="w-full" onClick={() => runCommand("addPage", ui)}>
            Add page
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Find / outline                                                       */
/* ------------------------------------------------------------------ */

type Found = { pageId: string; pageTitle: string; kind: "Component" | "Pin" | "Label" | "Page" | "Wire" | "Text"; id: string; text: string; sub?: string; at?: { x: number; y: number } };

function OutlinePanel() {
  const doc = useEditor((s) => s.doc);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const ui = useEditorUI();
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const f = () => ref.current?.focus();
    window.addEventListener("volt:focus-search", f);
    return () => window.removeEventListener("volt:focus-search", f);
  }, []);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const out: Found[] = [];
    const pages = [...doc.pages].sort((a, b) => a.order - b.order);
    for (const p of pages) {
      if (!t || p.title.toLowerCase().includes(t)) out.push({ pageId: p.id, pageTitle: p.title, kind: "Page", id: p.id, text: p.title });
      for (const e of p.elements) {
        const def = doc.defs[e.defId];
        if (!def || def.name === "volt_junction") continue;
        const hay = `${e.info.label ?? ""} ${def.name} ${Object.values(e.info).join(" ")}`.toLowerCase();
        if (!t || hay.includes(t)) out.push({ pageId: p.id, pageTitle: p.title, kind: "Component", id: e.id, text: e.info.label || def.name, sub: e.info.label ? def.name : undefined, at: e });
        if (t)
          for (const pin of def.pins)
            if ((pin.name && pin.name.toLowerCase().includes(t)) || (pin.number && pin.number.toLowerCase() === t))
              out.push({ pageId: p.id, pageTitle: p.title, kind: "Pin", id: e.id, text: `${e.info.label || def.name}:${pin.number || pin.name}`, sub: pin.name, at: e });
      }
      if (t) {
        for (const w of p.wires) if (w.label?.toLowerCase().includes(t)) out.push({ pageId: p.id, pageTitle: p.title, kind: "Wire", id: w.id, text: w.label, at: w.pts[0] });
        for (const x of p.texts) if (x.text.toLowerCase().includes(t)) out.push({ pageId: p.id, pageTitle: p.title, kind: "Text", id: x.id, text: x.text.slice(0, 60), at: x });
      }
      if (out.length > 500) break;
    }
    return out;
  }, [doc, q]);
  const locate = (f: Found) => {
    const s = useEditor.getState();
    if (s.pageId !== f.pageId) s.setPage(f.pageId);
    requestAnimationFrame(() => {
      if (f.kind === "Component" || f.kind === "Pin") s.setSel({ ...emptySel(), elements: [f.id] });
      if (f.kind === "Wire") s.setSel({ ...emptySel(), wires: [f.id] });
      if (f.kind === "Text") s.setSel({ ...emptySel(), texts: [f.id] });
      if (f.at) ui.engine.current?.centerOn(f.at, Math.max(ui.engine.current.view.s, 2));
      else ui.engine.current?.fit();
    });
  };
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-subtle" />
          <Input ref={ref} placeholder="Reference, label, pin, page…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-6" aria-label="Find in drawing" />
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {results.map((f, i) => (
          <li key={f.kind + f.id + i}>
            <button onClick={() => locate(f)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-hover">
              <span className="w-16 shrink-0 text-2xs text-subtle">{f.kind}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{f.text}</span>
              {f.sub && <span className="max-w-24 truncate text-2xs text-subtle">{f.sub}</span>}
              {f.kind !== "Page" && <span className="max-w-16 truncate text-2xs text-subtle">{f.pageTitle}</span>}
            </button>
          </li>
        ))}
        {!results.length && <p className="p-4 text-center text-xs text-subtle">No matches</p>}
      </ul>
    </div>
  );
}

export { parseElmt };

function BlockModeSelect() {
  const [m, setM] = useState<string>(() => {
    try {
      return localStorage.getItem("volt.blockMode") ?? "linked";
    } catch {
      return "linked";
    }
  });
  return (
    <select
      value={m}
      onChange={(e) => {
        setM(e.target.value);
        try {
          localStorage.setItem("volt.blockMode", e.target.value);
        } catch {}
      }}
      className="h-6 rounded border border-border bg-panel px-1 text-2xs text-muted"
      aria-label="Place blocks as"
      title="How placed blocks relate to their source"
    >
      <option value="linked">Place linked</option>
      <option value="derived">Place derived</option>
      <option value="independent">Place as copy</option>
    </select>
  );
}

type CatNodeT = { name: string; path: string; count: number; direct: number; children: CatNodeT[] };

function buildCatTree(cats: { path: string; count: number }[]): CatNodeT[] {
  const root: CatNodeT = { name: "", path: "", count: 0, direct: 0, children: [] };
  for (const c of cats) {
    const parts = c.path ? c.path.split("/") : ["Uncategorized"];
    let n = root;
    parts.forEach((seg, i) => {
      let ch = n.children.find((x) => x.name === seg);
      if (!ch) n.children.push((ch = { name: seg, path: parts.slice(0, i + 1).join("/"), count: 0, direct: 0, children: [] }));
      ch.count += c.count;
      if (i === parts.length - 1) ch.direct += c.count;
      n = ch;
    });
  }
  const sort = (n: CatNodeT) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function CatTree({ nodes, scope, kind, onPick, projectDefs, depth }: { nodes: CatNodeT[]; scope: string; kind: string; onPick: (i: LibItem) => void; projectDefs: Record<string, ElementDef>; depth: number }) {
  return (
    <>
      {nodes.map((n) => (
        <Category key={n.path} name={n.name} count={n.count} onPick={onPick} defaultOpen={nodes.length === 1 && depth < 2} projectDefs={projectDefs} lazy={{ path: n.path === "Uncategorized" ? "" : n.path, scope, kind, direct: n.direct }} depth={depth}>
          {n.children.length > 0 && <CatTree nodes={n.children} scope={scope} kind={kind} onPick={onPick} projectDefs={projectDefs} depth={depth + 1} />}
        </Category>
      ))}
    </>
  );
}
