"use client";
/** Folio report (off-page arrow): what it links to, link / unlink, go there, mark an unmarked arrow symbol. */
import { useMemo } from "react";
import { Crosshair, CornerDownRight, Unlink } from "lucide-react";
import { useEditor } from "../store";
import { mkSel } from "@/core/ops";
import { useEditorUI } from "./context";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import type { Doc, ElemInst, Page } from "@/core/model";
import { allReports, autoLinkReports, isReportDef, linkReports, looksLikeArrow, reportCandidates, sheetCell, unlinkReport } from "@/core/reports";
import { Row, Section } from "./Inspector";

export function ReportSection({ e, page, doc, editable }: { e: ElemInst; page: Page; doc: Doc; editable: boolean }) {
  const ui = useEditorUI();
  const s = useEditor.getState;
  const def = doc.defs[e.defId];
  const report = isReportDef(def);
  const reports = useMemo(() => (report ? allReports(doc) : []), [doc, report]);
  const linked = reports.filter((r) => e.links?.includes(r.e.id));
  const cands = useMemo(() => (report ? reportCandidates(doc, e.id).filter((r) => !e.links?.includes(r.e.id)) : []), [doc, e.id, e.links, report]);
  const label = (e.info.label ?? "").trim();

  if (!report) {
    if (!looksLikeArrow(def) || !editable) return null;
    // a library arrow that is not marked as a folio report: offer to mark it (project copy of the symbol)
    return (
      <Section title="Off-page arrow" defaultOpen>
        <p className="text-2xs text-muted">This symbol is not marked as a folio report, so its reference must be unique. Mark it to give several arrows the same reference and link them across sheets.</p>
        <div className="flex gap-1.5">
          {(["next_report", "previous_report"] as const).map((lt) => (
            <Button
              key={lt}
              size="xs"
              variant="secondary"
              onClick={() =>
                s().apply("Mark as folio report", (d) => {
                  d.defs[e.defId].linkType = lt;
                  autoLinkReports(d, label || undefined);
                })
              }
            >
              {lt === "next_report" ? "Going (outgoing)" : "Coming (incoming)"}
            </Button>
          ))}
        </div>
      </Section>
    );
  }

  const go = (id: string, pageId: string) => {
    const st = s();
    if (pageId !== st.pageId) st.setPage(pageId);
    st.setSel(mkSel({ elements: [id] }));
    setTimeout(() => ui.engine.current?.zoomToSelection(), 120);
  };
  const going = def.linkType === "next_report";
  return (
    <Section title={going ? "Folio report · going" : "Folio report · coming"} defaultOpen>
      {linked.length > 0 ? (
        <ul className="space-y-0.5">
          {linked.map((r) => (
            <li key={r.e.id} className="flex items-center gap-1 text-2xs">
              <CornerDownRight className="size-3 shrink-0 text-subtle" />
              <button className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-hover" onClick={() => go(r.e.id, r.page.id)} title="Go there">
                {going ? "continues at" : "comes from"} <b>{sheetCell(doc, r.page, r.e)}</b> · {r.page.title}
                {(r.e.info.label ?? "") !== (e.info.label ?? "") && <span className="text-warning"> · reference “{r.e.info.label || "—"}” differs</span>}
              </button>
              <Tip content="Go there">
                <Button size="icon-sm" variant="ghost" aria-label="Go to counterpart" onClick={() => go(r.e.id, r.page.id)}>
                  <Crosshair />
                </Button>
              </Tip>
              {editable && (
                <Tip content="Unlink">
                  <Button size="icon-sm" variant="ghost" aria-label="Unlink" onClick={() => s().apply("Unlink folio report", (d) => unlinkReport(d, e.id, r.e.id))}>
                    <Unlink />
                  </Button>
                </Tip>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-warning">Not linked — the conductor ends here.</p>
      )}
      {editable && (
        <Row label={linked.length ? "Also link" : "Link to"}>
          <NativeSelect
            value=""
            aria-label="Link to"
            onChange={(ev) => {
              const id = ev.target.value;
              if (!id) return;
              const o = cands.find((c) => c.e.id === id);
              s().apply("Link folio report", (d) => {
                linkReports(d, e.id, id);
                // same name on both ends: a linked pair is one signal
                if (o && label && !(o.e.info.label ?? "").trim()) {
                  const x = d.pages.flatMap((p) => p.elements).find((q) => q.id === id);
                  if (x) x.info.label = label;
                }
              });
            }}
          >
            <option value="">{cands.length ? `— ${going ? "coming" : "going"} arrow… —` : `no ${going ? "coming" : "going"} arrow in the project`}</option>
            {cands.map((c) => (
              <option key={c.e.id} value={c.e.id}>
                {c.e.info.label || "—"} · sheet {sheetCell(doc, c.page, c.e)} {c.page.id === page.id ? "(this sheet)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Row>
      )}
      <p className="text-2xs text-subtle">
        Give the {going ? "coming" : "going"} arrow on the other sheet the same reference{label ? ` (“${label}”)` : ""} and they link automatically. One going arrow can feed several coming arrows. The sheet and grid cell of the other end is printed next to the arrow.
      </p>
    </Section>
  );
}
