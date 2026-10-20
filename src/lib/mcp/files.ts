/**
 * Files an assistant asks for (PDF, DXF, SVG, PNG, QElectroTech project, .volt, bill of materials,
 * wire list, terminal plan, cable list): made on demand behind a signed, short-lived download link
 * — MCP results stay small, and the link works in a browser or with curl. The link names the
 * access token; revoking the token (or the person losing access) stops it.
 */
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { db } from "../db";
import { ctxForUser, HttpError, type Ctx } from "../session";
import { loadVersion, parseDoc } from "../versioning";
import { flushLive } from "../live/hooks";
import { exportPdf } from "@/core/render/pdf";
import { pageToDxf } from "@/core/render/dxf";
import { approxMeasure, pageToSvg } from "@/core/render/svg";
import { exportQet } from "@/core/qet";
import { buildBom, bomToCsv, bomToXlsx } from "@/core/bom";
import { svgToPng } from "../og/raster";
import { exportVolt } from "../voltfile/export";
import { VOLT_MIME } from "../voltfile/format";
import type { Doc, Page } from "@/core/model";
import { reportCsv, reportTable } from "./project";
import { findPage, sheets } from "./doc";

export const FILE_FORMATS = ["pdf", "dxf", "svg", "png", "qet", "volt", "bom_xlsx", "bom_csv", "wire_list_csv", "terminal_plan_csv", "cable_list_csv"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];
const LINK_MINUTES = 60;

/* ------------------------------------------------------------------ */
/* Signed links                                                         */
/* ------------------------------------------------------------------ */

type Claim = { v: string; f: FileFormat; p?: string[]; paper?: string; t: string; u: string; w: string; e: number };

const g = globalThis as unknown as { __voltMcpFileKey?: Buffer };
/** AUTH_SECRET when set (links survive restarts and work across instances), else a key for this process */
const key = () => (process.env.AUTH_SECRET ? createHmac("sha256", process.env.AUTH_SECRET).update("volt-mcp-files").digest() : (g.__voltMcpFileKey ??= randomBytes(32)));
const b64u = (b: Buffer) => b.toString("base64url");

export function signFileLink(c: Omit<Claim, "e">): { token: string; expires: Date } {
  const e = Date.now() + LINK_MINUTES * 60_000;
  const body = b64u(Buffer.from(JSON.stringify({ ...c, e })));
  const sig = b64u(createHmac("sha256", key()).update(body).digest());
  return { token: `${body}.${sig}`, expires: new Date(e) };
}

function readFileLink(token: string): Claim {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(404, "Not found");
  const want = createHmac("sha256", key()).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(404, "Not found");
  const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claim;
  if (!c.e || c.e < Date.now()) throw new HttpError(410, "This download link has expired — ask the assistant for a new one");
  return c;
}

/** the person behind a link, if the token is still valid */
export async function ctxForLink(token: string): Promise<{ ctx: Ctx; claim: Claim; tokenName: string }> {
  const claim = readFileLink(token);
  const t = await db.apiToken.findUnique({ where: { id: claim.t } });
  if (!t || t.revokedAt || t.userId !== claim.u || (t.expiresAt && t.expiresAt.getTime() < Date.now())) throw new HttpError(410, "The access token behind this link was revoked or has expired");
  const ctx = await ctxForUser(claim.u, { workspaceId: claim.w, authTime: 0, strict: true });
  if (!ctx) throw new HttpError(403, "No access");
  if (!ctx.settings.mcp.enabled) throw new HttpError(403, "The MCP server is turned off for this workspace");
  return { ctx, claim, tokenName: t.name };
}

/* ------------------------------------------------------------------ */
/* Making the files                                                     */
/* ------------------------------------------------------------------ */

const MIME: Record<FileFormat, string> = {
  pdf: "application/pdf",
  dxf: "application/dxf",
  svg: "image/svg+xml",
  png: "image/png",
  qet: "application/xml",
  volt: VOLT_MIME,
  bom_xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  bom_csv: "text/csv; charset=utf-8",
  wire_list_csv: "text/csv; charset=utf-8",
  terminal_plan_csv: "text/csv; charset=utf-8",
  cable_list_csv: "text/csv; charset=utf-8",
};
const EXT: Record<FileFormat, string> = { pdf: "pdf", dxf: "dxf", svg: "svg", png: "png", qet: "qet", volt: "volt", bom_xlsx: "xlsx", bom_csv: "csv", wire_list_csv: "csv", terminal_plan_csv: "csv", cable_list_csv: "csv" };
const SUFFIX: Partial<Record<FileFormat, string>> = { bom_xlsx: "_BOM", bom_csv: "_BOM", wire_list_csv: "_wires", terminal_plan_csv: "_terminals", cable_list_csv: "_cables" };

/** drawing pages for a page list (default: every sheet) */
function pagesOf(doc: Doc, refs?: string[]): Page[] {
  return refs?.length ? refs.map((r) => findPage(doc, r)) : sheets(doc);
}

/** one file per page, or a zip of them */
function perPage(base: string, ext: string, pages: Page[], make: (p: Page) => Uint8Array): { bytes: Uint8Array; filename: string; zipped: boolean } {
  if (pages.length === 1) return { bytes: make(pages[0]), filename: `${base}_${safe(pages[0].title)}.${ext}`, zipped: false };
  const files: Record<string, Uint8Array> = {};
  pages.forEach((p, i) => (files[`${String(i + 1).padStart(2, "0")}_${safe(p.title)}.${ext}`] = make(p)));
  return { bytes: zipSync(files, { level: 6 }), filename: `${base}_${ext}.zip`, zipped: true };
}
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";

export async function makeFile(ctx: Ctx, versionId: string, format: FileFormat, o: { pages?: string[]; paper?: string } = {}): Promise<{ bytes: Uint8Array; filename: string; type: string; label: string }> {
  await flushLive(versionId);
  const a = await loadVersion(ctx, versionId);
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  const doc = parseDoc(a.version.doc);
  const base = safe(`${a.project.number ? a.project.number + "_" : ""}${a.project.name}_v${a.version.label}`);
  const name = (ext: string) => `${base}${SUFFIX[format] ?? ""}.${ext}`;
  const out = (bytes: Uint8Array, filename: string, type = MIME[format]) => ({ bytes, filename, type, label: a.version.label });
  switch (format) {
    case "pdf": {
      const pages = pagesOf(doc, o.pages);
      const paper = (o.paper === "fit" ? "fit" : (o.paper ?? "A3")) as "A3";
      return out(await exportPdf(doc, { pages, paper, title: `${a.project.name} v${a.version.label}`, version: a.version.label, author: ctx.user.name }), name("pdf"));
    }
    case "dxf": {
      const r = perPage(base, "dxf", pagesOf(doc, o.pages), (p) => strToU8(pageToDxf(doc, p)));
      return out(r.bytes, r.filename, r.zipped ? "application/zip" : MIME.dxf);
    }
    case "svg": {
      const pages = pagesOf(doc, o.pages);
      const r = perPage(base, "svg", pages, (p) => strToU8(pageToSvg(doc, p, { measure: approxMeasure, lod: 100, background: "#ffffff", pageIndex: sheets(doc).indexOf(p), pageCount: sheets(doc).length })));
      return out(r.bytes, r.filename, r.zipped ? "application/zip" : MIME.svg);
    }
    case "png": {
      const pages = pagesOf(doc, o.pages);
      const r = perPage(base, "png", pages, (p) => svgToPng(pageToSvg(doc, p, { measure: approxMeasure, lod: 100, background: "#ffffff", pageIndex: sheets(doc).indexOf(p), pageCount: sheets(doc).length }), 3000));
      return out(r.bytes, r.filename, r.zipped ? "application/zip" : MIME.png);
    }
    case "qet":
      return out(strToU8(exportQet(doc).xml), name("qet"));
    case "volt": {
      const v = await exportVolt(ctx, { projectId: a.project.id, versionId, options: { reviews: true, history: false, files: true }, canManage: a.can("project.manage") });
      return out(v.bytes, v.filename);
    }
    case "bom_xlsx":
      return out(bomToXlsx(buildBom(doc, { pages: o.pages ? pagesOf(doc, o.pages) : undefined }), { title: `${a.project.name} — bill of materials`, subtitle: `v${a.version.label}` }), name("xlsx"));
    case "bom_csv":
      return out(strToU8(bomToCsv(buildBom(doc, { pages: o.pages ? pagesOf(doc, o.pages) : undefined }))), name("csv"));
    case "wire_list_csv":
      return out(strToU8(reportCsv(reportTable(doc, "wire_list", { pages: o.pages }))), name("csv"));
    case "terminal_plan_csv":
      return out(strToU8(reportCsv(reportTable(doc, "terminal_plan"))), name("csv"));
    case "cable_list_csv":
      return out(strToU8(reportCsv(reportTable(doc, "cable_list"))), name("csv"));
  }
}

export const fileMime = (f: FileFormat) => MIME[f];
export const fileExt = (f: FileFormat) => EXT[f];
