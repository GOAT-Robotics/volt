"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { parseElmt } from "@/core/qet";
import { symbolThumb } from "@/editor/thumb";
import { cn } from "@/lib/utils";

/** What the server's dry run reports for each element (see ImportPreview in lib/library/store). */
export type PreviewItem = {
  path: string;
  name: string;
  names: Record<string, string>;
  category: string;
  prefix: string;
  info: Record<string, string>;
  type: string;
  linkType: string;
  pins: number;
  width: number;
  height: number;
  uuid: string;
  duplicate: { id: string; name: string } | null;
  xml?: string;
};

/** Editable values of one element in the review. */
export type ReviewValues = {
  include: boolean;
  name: string;
  category: string;
  prefix: string;
  description: string;
  info: Record<InfoKey, string>;
};

export const REVIEW_INFO = [
  { key: "description", label: "Component name", placeholder: "e.g. Safety laser scanner" },
  { key: "rating", label: "Rating", placeholder: "e.g. 24 V DC, 10 A" },
  { key: "manufacturer", label: "Manufacturer", placeholder: "e.g. SICK" },
  { key: "manufacturer_reference", label: "Part number", placeholder: "e.g. S30A-6011BA" },
] as const;
type InfoKey = (typeof REVIEW_INFO)[number]["key"];

export const initialValues = (p: PreviewItem): ReviewValues => ({
  include: true,
  name: p.name,
  category: p.category,
  prefix: p.prefix,
  description: "",
  info: Object.fromEntries(REVIEW_INFO.map((f) => [f.key, p.info[f.key] ?? ""])) as Record<InfoKey, string>,
});

/** Only what the user changed goes to the server, so untouched files are stored byte for byte. */
export function overrideFor(p: PreviewItem, v: ReviewValues) {
  if (!v.include) return { exclude: true };
  const o: { name?: string; category?: string; prefix?: string; description?: string; info?: Record<string, string> } = {};
  if (v.name.trim() && v.name.trim() !== p.name) o.name = v.name.trim();
  if (v.category.trim() !== p.category) o.category = v.category.trim();
  if (v.prefix.trim() !== p.prefix) o.prefix = v.prefix.trim();
  if (v.description.trim()) o.description = v.description.trim();
  const info: Record<string, string> = {};
  for (const f of REVIEW_INFO) if ((v.info[f.key] ?? "").trim() !== (p.info[f.key] ?? "")) info[f.key] = v.info[f.key].trim();
  if (Object.keys(info).length) o.info = info;
  return Object.keys(o).length ? o : null;
}

const LANG: Record<string, string> = { fr: "French", de: "German", es: "Spanish", it: "Italian", nl: "Dutch", pt: "Portuguese", pl: "Polish", cs: "Czech", hu: "Hungarian", ru: "Russian", ar: "Arabic", ca: "Catalan", da: "Danish", el: "Greek", ro: "Romanian", sl: "Slovenian", tr: "Turkish", zh: "Chinese", ja: "Japanese" };

function Thumb({ item }: { item: PreviewItem }) {
  const src = useMemo(() => {
    if (!item.xml) return null;
    try {
      return symbolThumb(parseElmt(item.xml, { id: item.path }), 64);
    } catch {
      return null;
    }
  }, [item]);
  return <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-white">{src ? <img src={src} alt="" className="max-h-full max-w-full" /> : <span className="text-2xs text-subtle">—</span>}</div>;
}

export const IMPORT_CATS_LIST = "import-review-categories";

export function ReviewRow({
  item,
  v,
  onChange,
  dupMode,
  open,
  onToggle,
}: {
  item: PreviewItem;
  v: ReviewValues;
  onChange: (v: ReviewValues) => void;
  dupMode: string;
  open: boolean;
  onToggle: () => void;
}) {
  const set = (patch: Partial<ReviewValues>) => onChange({ ...v, ...patch });
  const others = Object.entries(item.names).filter(([l, n]) => l !== "en" && n !== v.name);
  const noEnglish = !item.names.en;
  const listId = IMPORT_CATS_LIST;
  return (
    <li className={cn("rounded-md border border-border", !v.include && "opacity-50")} data-review={item.path}>
      <div className="flex items-start gap-2.5 p-2">
        <input type="checkbox" className="mt-1" checked={v.include} onChange={(e) => set({ include: e.target.checked })} aria-label={`Import ${v.name}`} />
        <Thumb item={item} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Input value={v.name} onChange={(e) => set({ name: e.target.value })} className="h-7 text-xs font-medium" aria-label="Element name" disabled={!v.include} />
            <button className="flex shrink-0 items-center gap-0.5 text-2xs text-accent hover:underline" onClick={onToggle} type="button">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Details
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-2xs text-subtle">
            <span className="truncate font-mono">{item.path}</span>
            <span>·</span>
            <span>
              {item.pins} terminal{item.pins === 1 ? "" : "s"} · {item.width}×{item.height} · {item.type}
              {item.linkType !== "simple" ? ` (${item.linkType})` : ""}
            </span>
            {noEnglish && <Badge tone="warning">no English name{others.length ? ` — ${LANG[others[0][0]] ?? others[0][0]} only` : ""}</Badge>}
            {item.duplicate && <Badge tone={dupMode === "skip" ? "neutral" : "accent"}>{dupMode === "skip" ? "already in your library — will be skipped" : dupMode === "update" ? "already in your library — new revision" : "already in your library — separate copy"}</Badge>}
          </div>
          <div className="grid grid-cols-[1fr_88px] gap-1.5">
            <Input value={v.category} onChange={(e) => set({ category: e.target.value })} list={listId} placeholder="Category, e.g. Vendors/SICK" className="h-7 text-xs" aria-label="Category" disabled={!v.include} />
            <Input value={v.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="Prefix" className="h-7 text-xs" aria-label="Label prefix" title="Reference prefix, e.g. K, Q, A" disabled={!v.include} />
          </div>
          {open && (
            <div className="space-y-1.5 pt-1">
              <div className="grid grid-cols-2 gap-1.5">
                {REVIEW_INFO.map((f) => (
                  <label key={f.key} className="flex flex-col gap-0.5">
                    <span className="text-2xs text-muted">{f.label}</span>
                    <Input value={v.info[f.key]} onChange={(e) => set({ info: { ...v.info, [f.key]: e.target.value } })} placeholder={f.placeholder} className="h-7 text-xs" disabled={!v.include} />
                  </label>
                ))}
              </div>
              <label className="flex flex-col gap-0.5">
                <span className="text-2xs text-muted">Library notes</span>
                <Textarea rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="What it is, where it came from, variants…" className="text-xs" disabled={!v.include} />
              </label>
              {others.length > 0 && (
                <p className="text-2xs text-subtle">
                  Other names:{" "}
                  {others.map(([l, n], i) => (
                    <span key={l}>
                      {i > 0 && ", "}
                      <button type="button" className="text-accent hover:underline" onClick={() => set({ name: n })} title="Use this name">
                        {n}
                      </button>{" "}
                      ({LANG[l] ?? l})
                    </span>
                  ))}
                </p>
              )}
              <p className="font-mono text-[10px] text-subtle">uuid {item.uuid || "— (a new one is assigned)"}</p>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
