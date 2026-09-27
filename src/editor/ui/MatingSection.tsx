"use client";
/** Mated connector (plug ↔ socket): link a counterpart, gender, pin pairing, go to it. */
import { useMemo, useState } from "react";
import { ArrowRightLeft, Crosshair, Unlink } from "lucide-react";
import { useEditor } from "../store";
import { mkSel } from "@/core/ops";
import { useEditorUI } from "./context";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import type { Doc, ElemInst, Page } from "@/core/model";
import { clearMate, findElement, guessGender, isConnector, matedPinPairs, setMate, type Gender } from "@/core/mating";
import { cn } from "@/lib/utils";
import { Row, Section } from "./Inspector";

export function MatingSection({ e, page, doc, editable }: { e: ElemInst; page: Page; doc: Doc; editable: boolean }) {
  const ui = useEditorUI();
  const s = useEditor.getState;
  const def = doc.defs[e.defId];
  const mate = e.mate ? findElement(doc, e.mate.id) : null;
  const [pending, setPending] = useState<Gender | null>(null);
  const gender: Gender = e.mate?.gender ?? pending ?? guessGender(def) ?? "male";
  const pages = useMemo(() => [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order), [doc.pages]);
  // candidates: components with pins, the opposite gender and the same reference first
  const candidates = useMemo(() => {
    const out: { id: string; label: string; page: number; score: number }[] = [];
    pages.forEach((p, pi) => {
      for (const x of p.elements) {
        const d = doc.defs[x.defId];
        if (x.id === e.id || !d || !d.pins.length || d.name === "volt_junction") continue;
        const g = guessGender(d);
        const score = (g && g !== gender ? 2 : 0) + (x.info.label && e.info.label && x.info.label.replace(/[:.]?[mfMF]$/, "") === e.info.label.replace(/[:.]?[mfMF]$/, "") ? 3 : 0) + (d.pins.length === def?.pins.length ? 1 : 0) + (p.id === page.id ? 0.5 : 0);
        out.push({ id: x.id, label: `${x.info.label || "—"} · ${d.names.en ?? d.name}`, page: pi + 1, score });
      }
    });
    return out.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 300);
  }, [pages, doc.defs, e.id, e.info.label, gender, def?.pins.length, page.id]);
  const pairs = mate && def && doc.defs[mate.e.defId] ? matedPinPairs(e.mate!.gender === "male" ? def : doc.defs[mate.e.defId], e.mate!.gender === "male" ? doc.defs[mate.e.defId] : def) : [];
  const link = (id: string, g: Gender) => s().apply("Mate connectors", (d) => setMate(d, e.id, id, g));
  // only connectors (or something already mated) get this section
  if (!def?.pins.length || (!e.mate && !isConnector(def))) return null;
  return (
    <Section title="Mating connector" defaultOpen>
      <Row label="This side">
        <div className="flex rounded-md border border-border p-0.5 text-2xs" role="radiogroup" aria-label="Gender">
          {(["male", "female"] as const).map((g) => (
            <button
              key={g}
              role="radio"
              aria-checked={gender === g}
              disabled={!editable}
              className={cn("flex-1 rounded px-2 py-0.5 capitalize", gender === g ? "bg-hover font-medium text-fg" : "text-subtle")}
              onClick={() => (e.mate ? link(e.mate.id, g) : setPending(g))}
            >
              {g === "male" ? "Male (plug)" : "Female (socket)"}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Mates with">
        <div className="flex items-center gap-1">
          <NativeSelect value={e.mate?.id ?? ""} disabled={!editable} aria-label="Mates with" onChange={(ev) => (ev.target.value ? link(ev.target.value, gender) : s().apply("Unmate connectors", (d) => clearMate(d, e.id)))}>
            <option value="">— not mated —</option>
            {mate && !candidates.some((c) => c.id === mate.e.id) && <option value={mate.e.id}>{mate.e.info.label || "counterpart"}</option>}
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} (sheet {c.page})
              </option>
            ))}
          </NativeSelect>
          {mate && (
            <>
              <Tip content="Go to the counterpart">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Go to counterpart"
                  onClick={() => {
                    const st = s();
                    if (mate.page.id !== st.pageId) st.setPage(mate.page.id);
                    st.setSel(mkSel({ elements: [mate.e.id] }));
                    setTimeout(() => ui.engine.current?.zoomToSelection(), 120);
                  }}
                >
                  <Crosshair />
                </Button>
              </Tip>
              {editable && (
                <Tip content="Unmate">
                  <Button size="icon-sm" variant="ghost" aria-label="Unmate" onClick={() => s().apply("Unmate connectors", (d) => clearMate(d, e.id))}>
                    <Unlink />
                  </Button>
                </Tip>
              )}
            </>
          )}
        </div>
      </Row>
      {mate && e.mate && (
        <Row label="Label" hint={`“${e.mate.gender === "male" ? "▸" : "◂"} ${mate.e.info.label || "counterpart"}” on the drawing — drag it to move it`}>
          <div className="flex items-center gap-1">
            <NativeSelect
              value={e.mate.label ?? "auto"}
              disabled={!editable}
              aria-label="Counterpart label"
              onChange={(ev) => {
                const v = ev.target.value as "auto" | "show" | "hide";
                s().apply("Counterpart label", (d) => {
                  const x = findElement(d, e.id)?.e;
                  if (x?.mate) x.mate.label = v === "auto" ? undefined : v;
                });
              }}
            >
              <option value="auto">Auto (other sheet / far away)</option>
              <option value="show">Show</option>
              <option value="hide">Hide</option>
            </NativeSelect>
            {e.mate.labelPos && editable && (
              <Tip content="Put the label back under the symbol">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    s().apply("Reset label position", (d) => {
                      const x = findElement(d, e.id)?.e;
                      if (x?.mate) delete x.mate.labelPos;
                    })
                  }
                >
                  Reset
                </Button>
              </Tip>
            )}
          </div>
        </Row>
      )}
      {mate ? (
        <p className="flex items-start gap-1.5 text-2xs text-muted">
          <ArrowRightLeft className="mt-0.5 size-3 shrink-0" />
          <span>
            {pairs.length} pin{pairs.length === 1 ? "" : "s"} connected by number{pairs.length < def.pins.length ? ` · ${def.pins.length - pairs.length} without a partner` : ""}
            {mate.page.id === page.id ? " — wires on both sides form one net." : ` — on sheet ${pages.findIndex((p) => p.id === mate.page.id) + 1}; clicking the reference goes there.`}
          </span>
        </p>
      ) : (
        <p className="text-2xs text-subtle">Link a plug to its socket (or any two parts that connect pin to pin): pins pair up by number and the references cross-link.</p>
      )}
    </Section>
  );
}
