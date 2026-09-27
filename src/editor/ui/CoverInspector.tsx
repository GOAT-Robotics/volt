"use client";
/** Page type (drawing / cover sheet / contents), the cover sheet content and the revision history. */
import { ArrowDown, ArrowUp, History, ImagePlus, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useEditor } from "../store";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch, Tip } from "@/components/ui/misc";
import { getPage } from "@/core/ops";
import type { CoverSheet, Doc, Page, RevisionEntry } from "@/core/model";
import { coverFromPageTexts, DEFAULT_COVER } from "@/core/render/cover";
import { logoDataUrl } from "@/core/logos";
import { Commit, Row, Section } from "./Inspector";
import { PICTURE_LIMITS, readLogoFile } from "./logoUpload";

export function PageTypeRow({ page, editable }: { page: Page; editable: boolean }) {
  const s = useEditor.getState;
  return (
    <Row label="Page type">
      <NativeSelect
        value={page.kind ?? "drawing"}
        disabled={!editable}
        aria-label="Page type"
        onChange={(e) => {
          const kind = e.target.value as NonNullable<Page["kind"]>;
          if (kind === "cover" && !page.cover) {
            // take over a hand-typed "Label : value" cover
            const { cover, used } = coverFromPageTexts(page);
            const took = cover.fields.length && used.length ? used : [];
            s().apply("Make cover sheet", (d) => {
              const p = getPage(d, page.id);
              p.kind = "cover";
              p.cover = took.length ? cover : structuredClone(DEFAULT_COVER);
              if (took.length) p.texts = p.texts.filter((t) => !took.includes(t.id));
            });
            if (took.length) toast.success(`Cover sheet made from the typed text (${cover.fields.length} fields${cover.manufacturer ? ", manufacturer address" : ""}) — undo brings the text back`);
            return;
          }
          s().apply("Page type", (d) => {
            const p = getPage(d, page.id);
            if (kind === "drawing") delete p.kind;
            else p.kind = kind;
          });
        }}
      >
        <option value="drawing">Drawing</option>
        <option value="cover">Cover sheet</option>
        <option value="contents">Table of contents</option>
      </NativeSelect>
    </Row>
  );
}

export function CoverSection({ page, doc, editable }: { page: Page; doc: Doc; editable: boolean }) {
  const s = useEditor.getState;
  const c: CoverSheet = { ...DEFAULT_COVER, ...(page.cover ?? {}) };
  const upd = (label: string, fn: (c: CoverSheet) => void) =>
    s().apply(label, (d) => {
      const p = getPage(d, page.id);
      p.cover ??= structuredClone(DEFAULT_COVER);
      fn(p.cover);
    });
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const { name, logo } = await readLogoFile(f, PICTURE_LIMITS);
        upd("Cover picture", (x) => void (x.image = { ...logo, name }));
      } catch (e) {
        toast.error((e as Error).message);
      }
    };
    input.click();
  };
  const move = (i: number, j: number) =>
    upd("Reorder cover fields", (x) => {
      const f = x.fields;
      [f[i], f[j]] = [f[j], f[i]];
    });
  return (
    <>
      <Section title="Cover sheet">
        <Row label="Title">
          <Commit value={c.title ?? ""} placeholder={doc.meta.title} disabled={!editable} onCommit={(v) => upd("Cover title", (x) => void (x.title = v))} aria-label="Cover title" />
        </Row>
        <Row label="Subtitle">
          <Commit value={c.subtitle ?? ""} disabled={!editable} onCommit={(v) => upd("Cover subtitle", (x) => void (x.subtitle = v))} aria-label="Cover subtitle" />
        </Row>
        <Row label="Picture">
          <div className="flex items-center gap-2">
            <div className="flex h-12 w-20 items-center justify-center overflow-hidden rounded border border-border bg-white">
              {c.image ? <img src={logoDataUrl(c.image)} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-2xs text-subtle">none</span>}
            </div>
            {editable && (
              <>
                <Tip content="Product picture (PNG, JPEG or SVG)">
                  <Button size="icon-sm" variant="ghost" onClick={pickImage} aria-label="Cover picture">
                    <ImagePlus />
                  </Button>
                </Tip>
                {c.image && (
                  <Button size="icon-sm" variant="ghost" onClick={() => upd("Remove cover picture", (x) => void delete x.image)} aria-label="Remove picture">
                    <X />
                  </Button>
                )}
              </>
            )}
          </div>
        </Row>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium text-muted">Product data</span>
            {editable && (
              <Button size="xs" variant="ghost" onClick={() => upd("Add cover field", (x) => void x.fields.push({ label: "", value: "" }))}>
                <Plus /> Field
              </Button>
            )}
          </div>
          {c.fields.map((f, i) => (
            <div key={i} className="flex items-center gap-1">
              <Commit className="h-7 w-[42%] text-2xs" value={f.label} disabled={!editable} placeholder="Label" onCommit={(v) => upd("Cover field", (x) => void (x.fields[i].label = v))} aria-label={`Field ${i + 1} label`} />
              <Commit className="h-7 flex-1 text-2xs" value={f.value} disabled={!editable} placeholder="Value or %variable" onCommit={(v) => upd("Cover field", (x) => void (x.fields[i].value = v))} aria-label={`Field ${i + 1} value`} />
              {editable && (
                <div className="flex">
                  <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up">
                    <ArrowUp />
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={i === c.fields.length - 1} onClick={() => move(i, i + 1)} aria-label="Move down">
                    <ArrowDown />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => upd("Remove cover field", (x) => void x.fields.splice(i, 1))} aria-label="Remove field">
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          ))}
          <p className="text-2xs text-subtle">Values can use %projecttitle, %date, %indexrev and project properties (%customer…). Document no., revision and date at the top come from the title block fields.</p>
        </div>
        <Row label="Manufacturer">
          <Textarea rows={4} className="text-2xs" defaultValue={c.manufacturer ?? ""} key={c.manufacturer} disabled={!editable} placeholder={"Company name\nStreet\nCity, postcode\nCountry"} onBlur={(e) => e.target.value !== (c.manufacturer ?? "") && upd("Manufacturer", (x) => void (x.manufacturer = e.target.value))} onKeyDown={(e) => e.stopPropagation()} aria-label="Manufacturer" />
        </Row>
        <Row label="Notes">
          <Textarea rows={3} className="font-mono text-[11px]" defaultValue={c.notes ?? ""} key={c.notes} disabled={!editable} placeholder={"- Read the safety instructions first\n- **Isolate** before work"} onBlur={(e) => e.target.value !== (c.notes ?? "") && upd("Cover notes", (x) => void (x.notes = e.target.value))} onKeyDown={(e) => e.stopPropagation()} aria-label="Notes" />
        </Row>
        <Row label="Notice">
          <Textarea rows={2} className="text-2xs" defaultValue={c.notice ?? ""} key={c.notice} disabled={!editable} onBlur={(e) => e.target.value !== (c.notice ?? "") && upd("Cover notice", (x) => void (x.notice = e.target.value))} onKeyDown={(e) => e.stopPropagation()} aria-label="Notice" />
        </Row>
        <Row label="Revisions">
          <Switch checked={c.showRevisions !== false} disabled={!editable} onCheckedChange={(v) => upd("Revision table", (x) => void (x.showRevisions = v))} aria-label="Show revision history" />
        </Row>
      </Section>
      <RevisionsSection doc={doc} editable={editable} />
    </>
  );
}

/** the document's revision history (drawn on the cover sheet) */
export function RevisionsSection({ doc, editable }: { doc: Doc; editable: boolean }) {
  const s = useEditor.getState;
  const revs = doc.revisions ?? [];
  const upd = (label: string, fn: (r: RevisionEntry[]) => void) =>
    s().apply(label, (d) => {
      d.revisions ??= [];
      fn(d.revisions);
    });
  const fromVersions = async () => {
    const v = s().version;
    if (!v) return;
    const r = await fetch(`/api/projects/${v.projectId}/versions`);
    if (!r.ok) return void toast.error("Could not load the version history");
    const j = (await r.json()) as { versions: { label: string; summary: string; createdAt: string; createdBy: string; status: string }[] };
    const have = new Set(revs.map((x) => x.rev));
    const add = [...j.versions].reverse().filter((x) => !have.has(x.label));
    if (!add.length) return void toast.info("Every version is already listed");
    upd("Revisions from versions", (list) => {
      for (const x of add) list.push({ rev: x.label, date: x.createdAt.slice(0, 10), description: x.summary || x.status.toLowerCase(), drawn: x.createdBy });
    });
    toast.success(`${add.length} revision${add.length === 1 ? "" : "s"} added`);
  };
  return (
    <Section title="Revision history" defaultOpen={revs.length > 0}>
      <div className="space-y-1">
        {revs.map((r, i) => (
          <div key={i} className="grid grid-cols-[44px_78px_1fr_auto] gap-1">
            <Commit className="h-7 text-2xs" value={r.rev} disabled={!editable} placeholder="Rev" onCommit={(v) => upd("Revision", (l) => void (l[i].rev = v))} aria-label="Revision" />
            <Commit className="h-7 text-2xs" value={r.date} disabled={!editable} placeholder="Date" onCommit={(v) => upd("Revision", (l) => void (l[i].date = v))} aria-label="Date" />
            <Commit className="h-7 text-2xs" value={r.description} disabled={!editable} placeholder="Description" onCommit={(v) => upd("Revision", (l) => void (l[i].description = v))} aria-label="Description" />
            {editable && (
              <Button size="icon-sm" variant="ghost" onClick={() => upd("Remove revision", (l) => void l.splice(i, 1))} aria-label="Remove revision">
                <Trash2 />
              </Button>
            )}
            <div className="col-span-4 mb-1 grid grid-cols-3 gap-1">
              {(["drawn", "checked", "approved"] as const).map((k) => (
                <Commit key={k} className="h-6 text-2xs" value={r[k] ?? ""} disabled={!editable} placeholder={k[0].toUpperCase() + k.slice(1)} onCommit={(v) => upd("Revision", (l) => void (l[i][k] = v))} aria-label={k} />
              ))}
            </div>
          </div>
        ))}
        {editable && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" onClick={() => upd("Add revision", (l) => void l.push({ rev: "", date: new Date().toISOString().slice(0, 10), description: "" }))}>
              <Plus /> Revision
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void fromVersions()}>
              <History /> From Volt versions
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
