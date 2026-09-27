/** Project templates — pure helpers (usable from server, client and the seed script). */
import type { Doc, NumberingRule, PartialStyles, Styles } from "@/core/model";
import { newDoc, newPage } from "@/core/doc";
import { uid } from "@/core/ids";
import type { ApprovalPolicy } from "./settings";

export type ProjectTemplateContent = {
  /** page structure (titles, in order) */
  pages: { title: string }[];
  /** default title block field values applied to every page */
  titleBlockFields: Record<string, string>;
  /** style template to use as base styles (null = workspace default) */
  styleTemplateId?: string | null;
  /** organization title block layout for every page (null = workspace default layout) */
  titleBlockLayoutId?: string | null;
  /** project-level style overrides */
  styles?: PartialStyles;
  numbering?: NumberingRule[];
  /** metadata keys (doc.meta.props) that must be filled before submission */
  requiredFields: string[];
  approval?: Partial<ApprovalPolicy>;
  /** optional seed document (e.g. created from an existing project version) */
  doc?: Doc | null;
};

export const EMPTY_TEMPLATE: ProjectTemplateContent = {
  pages: [{ title: "Cover" }, { title: "Power" }, { title: "Control" }],
  titleBlockFields: { author: "", date: "", indexrev: "" },
  styleTemplateId: null,
  styles: {},
  numbering: [],
  requiredFields: [],
  approval: {},
  doc: null,
};

export function parseTemplateContent(s: string | null | undefined): ProjectTemplateContent {
  let v: Partial<ProjectTemplateContent> = {};
  try {
    v = JSON.parse(s || "{}");
  } catch {}
  return {
    pages: Array.isArray(v.pages) ? v.pages.filter((p) => p && typeof p.title === "string") : [],
    titleBlockFields: v.titleBlockFields && typeof v.titleBlockFields === "object" ? v.titleBlockFields : {},
    styleTemplateId: v.styleTemplateId ?? null,
    titleBlockLayoutId: v.titleBlockLayoutId ?? null,
    styles: v.styles ?? {},
    numbering: Array.isArray(v.numbering) ? v.numbering : [],
    requiredFields: Array.isArray(v.requiredFields) ? v.requiredFields.filter((x) => typeof x === "string" && x.trim()) : [],
    approval: v.approval ?? {},
    doc: v.doc ?? null,
  };
}

/** Build the initial document of a new project from a template. */
export function docFromTemplate(title: string, t: ProjectTemplateContent | null, base: Styles, props: Record<string, string> = {}): Doc {
  let doc: Doc;
  if (t?.doc) {
    doc = structuredClone(t.doc);
    delete doc.qet;
    doc.meta = { ...doc.meta, title };
    doc.baseStyles = t.styleTemplateId ? base : doc.baseStyles ?? base;
  } else {
    doc = newDoc(title, base);
    if (t && t.pages.length) doc.pages = t.pages.map((p, i) => newPage(i, p.title || `Page ${i + 1}`));
  }
  if (t) {
    for (const p of doc.pages) p.titleBlock.fields = { ...p.titleBlock.fields, ...t.titleBlockFields, title: p.titleBlock.fields.title || p.title };
    if (t.styles && Object.keys(t.styles).length) doc.styles = structuredClone(t.styles);
    if (t.numbering && t.numbering.length) doc.numbering = { ...doc.numbering, rules: t.numbering.map((r) => ({ ...r, id: r.id || uid() })) };
    for (const f of t.requiredFields) if (!(f in doc.meta.props)) doc.meta.props[f] = "";
  }
  doc.meta.props = { ...doc.meta.props, ...props };
  return doc;
}

/** Derive template content from an existing project document. */
export function templateFromDoc(doc: Doc): ProjectTemplateContent {
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const first = pages[0];
  const tb = { ...(first?.titleBlock.fields ?? {}) };
  delete tb.title;
  const seed = structuredClone(doc);
  delete seed.qet;
  return {
    pages: pages.map((p) => ({ title: p.title })),
    titleBlockFields: tb,
    styleTemplateId: doc.baseStylesRef?.templateId ?? null,
    styles: doc.styles ?? {},
    numbering: doc.numbering?.rules ?? [],
    requiredFields: [],
    approval: {},
    doc: seed,
  };
}

/** Missing required metadata fields for a doc. */
export function missingFields(doc: Doc, required: string[]): string[] {
  return required.filter((f) => !String(doc.meta.props?.[f] ?? "").trim());
}
