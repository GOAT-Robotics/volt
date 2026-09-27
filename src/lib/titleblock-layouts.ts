import "server-only";
import { db } from "./db";
import { parseHistory } from "./styletemplates";
import { parseTitleBlockTemplate, serializeTitleBlockTemplate, templateLogos } from "@/core/qet/titleblock";
import { HttpError } from "./session";
import type { Doc, TitleBlockTemplate } from "@/core/model";

type Row = { id: string; name: string; xml: string; status: string; history: string; version: number; isDefault: boolean };

/**
 * The layout a project may use: the current xml when APPROVED, else the last approved snapshot
 * (so editing an organization layout never silently changes new projects). Null if never approved.
 */
export function approvedLayout(t: Row): { xml: string; version: number } | null {
  if (t.status === "RETIRED") return null;
  if (t.status === "APPROVED") return { xml: t.xml, version: t.version };
  const h = parseHistory(t.history).filter((e) => e.action === "approve" && typeof e.content === "string");
  const last = h[h.length - 1];
  return last ? { xml: last.content as string, version: last.version } : null;
}

/** Organization layouts usable in projects (approved at least once, not retired). */
export async function usableLayouts(workspaceId: string) {
  const rows = await db.titleBlockLayout.findMany({ where: { workspaceId, status: { not: "RETIRED" } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return rows.flatMap((r) => {
    const a = approvedLayout(r);
    return a ? [{ id: r.id, name: r.name, isDefault: r.isDefault, version: a.version, xml: a.xml }] : [];
  });
}

/** Parsed, approved layout as a document title block template (named after the layout). */
export function layoutTemplate(l: { id: string; version: number; name: string; xml: string }): TitleBlockTemplate | null {
  try {
    const t = parseTitleBlockTemplate(l.xml);
    return { ...t, name: l.name, layout: { id: l.id, version: l.version } };
  } catch {
    return null;
  }
}

/** Puts an organization layout on every page of a new document. */
export function applyLayout(doc: Doc, t: TitleBlockTemplate) {
  doc.titleBlocks = { ...doc.titleBlocks, [t.name]: t };
  for (const p of doc.pages) {
    p.titleBlock.template = t.name;
    p.titleBlock.show = true;
  }
  // the built-in template of a fresh document is no longer used
  for (const k of Object.keys(doc.titleBlocks)) if (k !== t.name && !doc.pages.some((p) => p.titleBlock.template === k)) delete doc.titleBlocks[k];
}

/** The layout for a new project: an explicit choice, else the workspace default. */
export async function layoutForNewProject(workspaceId: string, layoutId: string | null | undefined) {
  const all = await usableLayouts(workspaceId);
  const l = layoutId ? all.find((x) => x.id === layoutId) : all.find((x) => x.isDefault);
  return l ? layoutTemplate(l) : null;
}

/** a layout with a few logos; QET files are plain XML with base64 images */
export const MAX_LAYOUT_XML = 6 * 1024 * 1024;

export function checkLayoutXml(xml: string, name: string): string {
  if (xml.length > MAX_LAYOUT_XML) throw new HttpError(413, "Layout too large (logos included, max 6 MB)");
  try {
    const t = parseTitleBlockTemplate(xml);
    if (t.name === name) return xml;
    // the stored xml carries the layout's name; logos and unknown nodes are kept
    return serializeTitleBlockTemplate({ ...t, name, logos: templateLogos(t), xml });
  } catch (e) {
    throw new HttpError(400, `Not a valid title block template: ${(e as Error).message.slice(0, 200)}`);
  }
}

