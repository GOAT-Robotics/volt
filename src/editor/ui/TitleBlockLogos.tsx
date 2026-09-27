"use client";
import { useMemo, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { useEditor } from "../store";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import type { Doc, TitleBlockLogo, TitleBlockTemplate } from "@/core/model";
import { logoBytes, logoDataUrl, logoKey } from "@/core/logos";
import { serializeTitleBlockTemplate, templateLogos } from "@/core/qet/titleblock";
import { LOGO_MAX_INPUT, LOGO_MAX_STORED, readLogoFile } from "./logoUpload";

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/** Every logo in the project's templates, by name (first one wins on a name clash). */
function projectLogos(doc: Doc): Map<string, TitleBlockLogo> {
  const out = new Map<string, TitleBlockLogo>();
  for (const t of Object.values(doc.titleBlocks)) for (const [n, l] of Object.entries(templateLogos(t))) if (!out.has(n)) out.set(n, l);
  return out;
}

function cellName(c: TitleBlockTemplate["cells"][number], i: number, tpl: TitleBlockTemplate, total: number) {
  if (c.name && c.name !== "logo") return c.name;
  if (total === 1) return "Logo";
  const cols = tpl.cols.length;
  const where = c.col === 0 ? "left" : c.col + c.colspan >= cols - 1 ? "right" : `column ${c.col + 1}`;
  return `Logo ${i + 1} (${where})`;
}

/**
 * Logo cells of the page's title block template. A logo belongs to the template, so it shows on
 * every page that uses the template, fitted into the cell the template defines.
 */
export function TitleBlockLogos({ doc, templateName, editable }: { doc: Doc; templateName: string; editable: boolean }) {
  const tpl = doc.titleBlocks[templateName];
  const cells = useMemo(() => (tpl?.cells ?? []).map((c, idx) => ({ c, idx })).filter((x) => x.c.type === "logo"), [tpl]);
  const all = useMemo(() => projectLogos(doc), [doc]);
  const file = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (!tpl || !cells.length) return null;
  const mine = templateLogos(tpl);

  /**
   * Sets the logo of one cell. The result is written into the template's QET xml (which is
   * what the document stores and exports); the template keeps only logos its cells use.
   */
  const assign = (cellIdx: number, name: string | null, logo?: TitleBlockLogo) => {
    const cellsNext = tpl.cells.map((c, i) => (i === cellIdx ? { ...c, value: name ?? "" } : c));
    const used = new Set(cellsNext.filter((c) => c.type === "logo" && c.value).map((c) => c.value!));
    const logos: Record<string, TitleBlockLogo> = {};
    for (const [n, l] of Object.entries({ ...mine, ...(name && logo ? { [name]: logo } : {}) })) if (used.has(n)) logos[n] = l;
    let xml: string;
    try {
      xml = serializeTitleBlockTemplate({ ...tpl, cells: cellsNext, logos });
    } catch {
      return void toast.error("Could not update the title block template");
    }
    useEditor.getState().apply(name ? "Title block logo" : "Remove title block logo", (d) => {
      const t = d.titleBlocks[templateName];
      if (!t) return;
      t.cells[cellIdx].value = name ?? "";
      t.xml = xml;
      delete t.logos;
    });
  };

  const upload = async (f: File) => {
    if (target === null) return;
    setBusy(true);
    try {
      const { name, logo, note } = await readLogoFile(f);
      // a different image under an existing name gets a fresh name
      let n = name;
      for (let i = 2; all.has(n) && logoKey(all.get(n)!) !== logoKey(logo); i++) n = name.replace(/(\.[^.]+)$/, `-${i}$1`);
      assign(target, n, logo);
      toast.success(`Logo added${note ? ` (${note})` : ""}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs font-medium text-muted">Logos</span>
        <span className="text-2xs text-subtle">every page using “{templateName}”</span>
      </div>
      {cells.map(({ c, idx }, i) => {
        const logo = c.value ? mine[c.value] : undefined;
        return (
          <div key={idx} className="space-y-1" data-logo-cell={idx}>
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-white">
                {logo ? <img src={logoDataUrl(logo)} alt={c.value} className="max-h-full max-w-full object-contain" /> : <span className="text-2xs text-subtle">none</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-2xs font-medium">{cellName(c, i, tpl, cells.length)}</p>
                <p className="truncate text-2xs text-subtle">{logo ? `${c.value} · ${kb(logoBytes(logo))}` : c.value ? `${c.value} (missing)` : "No logo"}</p>
              </div>
              {editable && (
                <>
                  <Tip content={`Upload PNG, JPEG or SVG (up to ${kb(LOGO_MAX_INPUT)}; stored at most ${kb(LOGO_MAX_STORED)})`}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Upload logo"
                      disabled={busy}
                      onClick={() => {
                        setTarget(idx);
                        file.current?.click();
                      }}
                    >
                      <ImagePlus />
                    </Button>
                  </Tip>
                  {c.value && (
                    <Tip content="Remove logo">
                      <Button size="icon-sm" variant="ghost" aria-label="Remove logo" onClick={() => assign(idx, null)}>
                        <X />
                      </Button>
                    </Tip>
                  )}
                </>
              )}
            </div>
            {editable && all.size > 0 && (
              <NativeSelect
                aria-label="Choose a logo"
                className="h-6 text-2xs"
                value={logo ? c.value : ""}
                onChange={(e) => {
                  const n = e.target.value;
                  if (!n) return assign(idx, null);
                  const l = all.get(n);
                  if (l) assign(idx, n, l);
                }}
              >
                <option value="">— no logo —</option>
                {[...all.keys()].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
        );
      })}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
        className="hidden"
        data-testid="logo-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
    </div>
  );
}
