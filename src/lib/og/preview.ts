import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db, J } from "@/lib/db";
import { parseSettings, type WorkspaceSettings } from "@/lib/settings";
import { APPROVED_REV_KEY, ORG_LIVE } from "@/lib/library/access";
import { blockSvg, elmtSvg } from "@/lib/library/preview";
import { approxMeasure, pageToSvg } from "@/core/render/svg";
import type { BlockContent, Doc, ElementDef, Page, TitleBlockTemplate } from "@/core/model";
import { defaultStyles } from "@/core/styles";
import { cardSvg, type Card } from "./card";
import { svgToPng } from "./raster";

/**
 * Link previews (Open Graph). Teams, Slack, Outlook, WhatsApp … fetch a pasted link from their own
 * servers, without the user's session, so what they may see is an organization decision
 * (Administration → Access → Link previews):
 *   off     — "Volt" only
 *   name    — the project / component name and short facts, no picture
 *   picture — name, facts and a picture of the project's title page / the symbol
 * Only projects of the workspace and library items published to the whole organization are ever
 * described; personal and shared-with-me library items stay generic.
 */

export type Preview = {
  title: string;
  description: string;
  /** path of the canonical page */
  path: string;
  /** path of the image (with a cache-busting version) */
  image: string;
  imageAlt: string;
};

export const SITE_NAME = "Volt";
export const SITE_DESCRIPTION =
  "Volt is Example Company's electrical design workspace: schematics compatible with QElectroTech, a shared component library, reviews, approvals and signed releases.";

let logoUri: string | null | undefined;
export function brandLogoDataUri(): string | null {
  if (logoUri !== undefined) return logoUri;
  try {
    logoUri = "data:image/png;base64," + readFileSync(path.join(process.cwd(), "public", "brand", "logo.png")).toString("base64");
  } catch {
    logoUri = null;
  }
  return logoUri;
}

async function workspaceMode(workspaceId: string): Promise<WorkspaceSettings["linkPreviews"]> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  return ws ? parseSettings(ws.settings).linkPreviews : "off";
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

/* ------------------------------------------------------------------ */
/* Projects                                                             */
/* ------------------------------------------------------------------ */

type ProjectInfo = {
  mode: WorkspaceSettings["linkPreviews"];
  project: { id: string; name: string; number: string | null; description: string; updatedAt: Date };
  version: { id: string; label: string; status: string; docRev: number } | null;
  pages: { idx: number; kind: string | null; order: number; title: string }[];
};

async function projectInfo(id: string): Promise<ProjectInfo | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const project = await db.project.findUnique({ where: { id }, select: { id: true, name: true, number: true, description: true, updatedAt: true, workspaceId: true } });
  if (!project) return null;
  const mode = await workspaceMode(project.workspaceId);
  if (mode === "off") return { mode, project, version: null, pages: [] };
  const version = await db.version.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" }, select: { id: true, label: true, status: true, docRev: true } });
  let pages: ProjectInfo["pages"] = [];
  if (version) {
    const rows = await db.$queryRaw<{ k: number; kind: string | null; ord: number | null; title: string | null }[]>`
      SELECT p.key AS k, json_extract(p.value, '$.kind') AS kind, json_extract(p.value, '$.order') AS ord, json_extract(p.value, '$.title') AS title
      FROM "Version" v, json_each(v.doc, '$.pages') p WHERE v.id = ${version.id}`;
    pages = rows.map((r) => ({ idx: Number(r.k), kind: r.kind, order: Number(r.ord ?? r.k), title: r.title ?? "" })).sort((a, b) => a.order - b.order);
  }
  return { mode, project, version, pages };
}

/** the page that best represents the project: a cover sheet, else the first drawing */
function titlePage(pages: ProjectInfo["pages"]) {
  return pages.find((p) => p.kind === "cover") ?? pages.find((p) => p.kind !== "contents") ?? pages[0] ?? null;
}

export async function projectPreview(id: string): Promise<Preview | null> {
  const info = await projectInfo(id);
  if (!info || info.mode === "off") return null;
  const { project, version, pages } = info;
  const facts = [version ? `Version ${version.label} · ${cap(version.status)}` : null, pages.length ? `${pages.length} sheet${pages.length === 1 ? "" : "s"}` : null].filter(Boolean);
  const tag = createHash("sha1").update(`${info.mode}|${project.name}|${project.number}|${version?.id}|${version?.docRev}|${version?.status}`).digest("hex").slice(0, 12);
  const tp = titlePage(pages);
  return {
    title: project.number ? `${project.name} (${project.number})` : project.name,
    description: short(project.description.trim() || `Electrical project${facts.length ? " · " + facts.join(" · ") : ""}. Open in Volt to view the drawings.`, 200),
    path: `/projects/${project.id}`,
    image: `/og/project/${project.id}?v=${tag}`,
    imageAlt: info.mode === "picture" && tp ? `${tp.title || "Title page"} of ${project.name}` : project.name,
  };
}

/** Load just what one page needs to be drawn: the page, its symbols and its title block. */
async function loadPageDoc(versionId: string, idx: number): Promise<{ doc: Doc; page: Page } | null> {
  const [head] = await db.$queryRaw<{ meta: string | null; baseStyles: string | null; styles: string | null; wiring: string | null; cables: string | null; revisions: string | null; grid: string | null; page: string | null }[]>`
    SELECT json_extract(doc, '$.meta') AS meta, json_extract(doc, '$.baseStyles') AS baseStyles, json_extract(doc, '$.styles') AS styles,
           json_extract(doc, '$.wiring') AS wiring, json_extract(doc, '$.cables') AS cables, json_extract(doc, '$.revisions') AS revisions,
           json_extract(doc, '$.grid') AS grid, json_extract(doc, '$.pages[' || ${idx} || ']') AS page
    FROM "Version" WHERE id = ${versionId}`;
  if (!head?.page) return null;
  const page = J.parse<Page | null>(head.page, null);
  if (!page) return null;
  const defIds = [...new Set(page.elements.map((e) => e.defId))];
  const defs: Record<string, ElementDef> = {};
  if (defIds.length) {
    const rows = await db.$queryRaw<{ k: string; v: string }[]>`
      SELECT d.key AS k, d.value AS v FROM "Version" v, json_each(v.doc, '$.defs') d WHERE v.id = ${versionId} AND d.key IN (${Prisma.join(defIds)})`;
    for (const r of rows) defs[r.k] = JSON.parse(r.v) as ElementDef;
  }
  const titleBlocks: Record<string, TitleBlockTemplate> = {};
  const tb = page.titleBlock?.template;
  if (tb) {
    const rows = await db.$queryRaw<{ v: string }[]>`
      SELECT t.value AS v FROM "Version" v, json_each(v.doc, '$.titleBlocks') t WHERE v.id = ${versionId} AND t.key = ${tb}`;
    if (rows[0]) titleBlocks[tb] = JSON.parse(rows[0].v) as TitleBlockTemplate;
  }
  const doc: Doc = {
    schema: 1,
    meta: J.parse(head.meta, { title: "", props: {} }),
    revisions: J.parse(head.revisions, undefined),
    baseStyles: J.parse(head.baseStyles, null) ?? defaultStyles(),
    styles: J.parse(head.styles, {}),
    numbering: { rules: [], autoOnPlace: false },
    pages: [page],
    defs,
    titleBlocks,
    grid: J.parse(head.grid, { size: 10, show: false }),
    wiring: J.parse(head.wiring, undefined),
    cables: J.parse(head.cables, undefined),
  };
  return { doc, page };
}

export async function projectCardPng(id: string): Promise<{ png: Buffer; etag: string } | null> {
  const info = await projectInfo(id);
  if (!info || info.mode === "off") return null;
  const { project, version, pages, mode } = info;
  const key = `p|${id}|${mode}|${project.name}|${project.number}|${project.updatedAt.getTime()}|${version?.id}|${version?.docRev}|${version?.status}`;
  return cached(key, async () => {
    let picture: string | null = null;
    const tp = titlePage(pages);
    if (mode === "picture" && version && tp) {
      const pd = await loadPageDoc(version.id, tp.idx).catch((e) => (console.error("[og] page", id, e), null));
      if (pd) {
        try {
          picture = pageToSvg(pd.doc, pd.page, { measure: approxMeasure, lod: 100, pageIndex: pages.indexOf(tp), pageCount: pages.length, background: "#ffffff" });
        } catch (e) {
          console.error("[og] render", id, e);
        }
      }
    }
    const card: Card = {
      kicker: project.number ? `Project · ${project.number}` : "Electrical project",
      title: project.name,
      lines: [
        ...(version ? [`Version ${version.label} · ${cap(version.status)}`] : []),
        ...(pages.length ? [`${pages.length} sheet${pages.length === 1 ? "" : "s"}${tp?.kind === "cover" ? " · with cover sheet" : ""}`] : []),
        ...(project.description.trim() ? [project.description.trim().split("\n")[0]] : []),
      ],
      picture,
      frame: true,
      brandLogo: brandLogoDataUri(),
      seed: seedOf(id),
    };
    return svgToPng(cardSvg(card), 1200);
  });
}

/* ------------------------------------------------------------------ */
/* Library (symbols and blocks)                                         */
/* ------------------------------------------------------------------ */

type LibInfo = {
  mode: WorkspaceSettings["linkPreviews"];
  el: { id: string; kind: string; name: string; category: string; description: string; prefix: string; meta: Record<string, unknown>; status: string; revision: number; library: string };
  /** the revision the organization sees */
  revision: number;
  content: () => Promise<string | null>;
};

async function libInfo(id: string): Promise<LibInfo | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const el = await db.libraryElement.findUnique({ where: { id }, omit: { content: true }, include: { library: { select: { name: true, workspaceId: true } } } });
  if (!el || el.visibility !== "ORG") return null;
  const meta = J.parse<Record<string, unknown>>(el.meta, {});
  const approvedRev = Number(meta[APPROVED_REV_KEY]) || null;
  const live = ORG_LIVE.includes(el.status as (typeof ORG_LIVE)[number]) || el.status === "DEPRECATED";
  if (!live && !(el.approvedAt && approvedRev)) return null; // drafts are not public knowledge
  const revision = live ? el.revision : approvedRev!;
  const mode = await workspaceMode(el.library.workspaceId);
  return {
    mode,
    el: { id: el.id, kind: el.kind, name: el.name, category: el.category, description: el.description, prefix: el.prefix, meta, status: el.status, revision: el.revision, library: el.library.name },
    revision,
    content: async () => {
      if (revision === el.revision) return (await db.libraryElement.findUnique({ where: { id }, select: { content: true } }))?.content ?? null;
      return (await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: id, revision } }, select: { content: true } }))?.content ?? null;
    },
  };
}

const metaStr = (m: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (typeof m[k] === "string" && (m[k] as string).trim()) return (m[k] as string).trim();
  return "";
};
const categoryName = (c: string) => (c.split("/").filter(Boolean).pop() ?? "").replace(/^\d+_/, "").replace(/_/g, " ");

function libFacts(i: LibInfo): string[] {
  const m = i.el.meta;
  const maker = [metaStr(m, "manufacturer"), metaStr(m, "partNumber", "manufacturerReference", "reference")].filter(Boolean).join(" ");
  return [maker, categoryName(i.el.category) ? cap(categoryName(i.el.category)) : "", `Revision ${i.revision} · ${cap(i.el.status)}`, i.el.library].filter(Boolean);
}

export async function libraryPreview(id: string): Promise<Preview | null> {
  const i = await libInfo(id);
  if (!i || i.mode === "off") return null;
  const what = i.el.kind === "BLOCK" ? "Circuit block" : "Component symbol";
  const tag = createHash("sha1").update(`${i.mode}|${i.el.name}|${i.revision}|${i.el.status}`).digest("hex").slice(0, 12);
  return {
    title: i.el.name,
    description: short(i.el.description.trim() || `${what} in the ${i.el.library} library. ${libFacts(i).slice(0, 2).join(" · ")}`, 200),
    path: `/library/${i.el.id}`,
    image: `/og/library/${i.el.id}?v=${tag}`,
    imageAlt: `${what}: ${i.el.name}`,
  };
}

export async function libraryCardPng(id: string): Promise<{ png: Buffer; etag: string } | null> {
  const i = await libInfo(id);
  if (!i || i.mode === "off") return null;
  return cached(`l|${id}|${i.mode}|${i.revision}|${i.el.status}|${i.el.name}`, async () => {
    let picture: string | null = null;
    if (i.mode === "picture") {
      const content = await i.content();
      try {
        if (content) picture = i.el.kind === "BLOCK" ? blockSvg(JSON.parse(content) as BlockContent, i.el.name) : elmtSvg(content, { label: i.el.prefix ? `-${i.el.prefix}1` : "", pinNumbers: true, pad: 6 });
      } catch (e) {
        console.error("[og] symbol", id, e);
      }
    }
    const card: Card = {
      kicker: i.el.kind === "BLOCK" ? "Circuit block" : "Component",
      title: i.el.name,
      lines: libFacts(i),
      picture,
      frame: i.el.kind === "BLOCK",
      brandLogo: brandLogoDataUri(),
      seed: seedOf(id),
    };
    return svgToPng(cardSvg(card), 1200);
  });
}

/* ------------------------------------------------------------------ */
/* Site card and cache                                                  */
/* ------------------------------------------------------------------ */

export async function siteCardPng(): Promise<{ png: Buffer; etag: string }> {
  return (await cached("site|v1", async () =>
    svgToPng(
      cardSvg({
        kicker: "Example Company · Electrical engineering",
        title: "Electrical diagrams & document control",
        lines: ["Schematics, component library, reviews and signed releases"],
        brandLogo: brandLogoDataUri(),
        seed: 5,
      }),
      1200,
    ),
  ))!;
}

const seedOf = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** a few rendered cards in memory (rendering takes 50–300 ms) */
const cache = new Map<string, { png: Buffer; etag: string }>();
const inflight = new Map<string, Promise<{ png: Buffer; etag: string } | null>>();
const MAX = 40;
async function cached(key: string, make: () => Promise<Buffer>): Promise<{ png: Buffer; etag: string } | null> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let p = inflight.get(key);
  if (!p) {
    p = make()
      .then((png) => {
        const v = { png, etag: `"${createHash("sha1").update(png).digest("hex").slice(0, 20)}"` };
        cache.set(key, v);
        while (cache.size > MAX) cache.delete(cache.keys().next().value!);
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
