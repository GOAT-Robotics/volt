/**
 * Standard library: the complete default element collection (≈8,800 symbols across electric, logic,
 * hydraulic, pneumatic and energy) plus a starter set of reusable circuit blocks.
 *
 * The collection ships with Volt as seed/elements.tgz and is installed into every workspace
 * automatically (server start and `npm run db:seed`). Installing is idempotent: elements are matched
 * by uuid, so re-running after a collection update only adds what is new.
 */
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parseElmt } from "@/core/qet/elmt";
import { guessPrefix } from "./elmt-tools";
import { installStandardBlocks } from "./standard-blocks";

export const STANDARD_SOURCE = "volt:standard";
export const STANDARD_LIBRARY_NAME = "Standard library";
const LICENSE = "CC-BY 3.0";
const ATTRIBUTION = "Element collection by the QElectroTech project and contributors (qelectrotech.org), CC-BY 3.0.";

export const seedDir = () => path.join(process.env.VOLT_SEED_DIR || path.join(process.cwd(), "seed"));

/* ------------------------------------------------------------------ */
/* Minimal ustar reader                                                 */
/* ------------------------------------------------------------------ */

type TarEntry = { name: string; data: Buffer };

export function* readTar(buf: Buffer): Generator<TarEntry> {
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    if (prefix) name = prefix + "/" + name;
    const start = off + 512;
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0" || type === "7") yield { name: name.replace(/^\.\//, ""), data: Buffer.from(data) };
  }
}

/* ------------------------------------------------------------------ */
/* Collection → records                                                 */
/* ------------------------------------------------------------------ */

const humanize = (folder: string) =>
  folder
    .replace(/^\d+[_-]?/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || folder;

function dirName(xml: string, folder: string): string {
  const pick = (lang: string) => new RegExp(`<name\\s+lang="${lang}"\\s*>([^<]*)</name>`).exec(xml)?.[1]?.trim();
  const n = pick("en") || humanize(folder);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export type StandardElement = { path: string; category: string; order: string; xml: string };

/** Reads the bundled collection: every .elmt with its English category path. */
export async function readCollection(): Promise<{ version: string; elements: StandardElement[]; license: string }> {
  const dir = seedDir();
  const [tgz, version] = await Promise.all([readFile(path.join(dir, "elements.tgz")), readFile(path.join(dir, "elements.version"), "utf8").catch(() => "unknown")]);
  const entries = [...readTar(gunzipSync(tgz))];
  const dirNames = new Map<string, string>();
  let license = "";
  for (const e of entries) {
    if (e.name.endsWith("/qet_directory") || e.name === "qet_directory") {
      const d = e.name.slice(0, -"/qet_directory".length);
      dirNames.set(d, dirName(e.data.toString("utf8"), d.split("/").pop() ?? d));
    }
    if (e.name.endsWith("ELEMENTS.LICENSE")) license = e.data.toString("utf8");
  }
  const elements: StandardElement[] = [];
  for (const e of entries) {
    if (!e.name.endsWith(".elmt")) continue;
    const parts = e.name.split("/").slice(0, -1);
    const cat: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      cat.push((dirNames.get(d) ?? humanize(parts[i - 1])).replace(/\//g, "-"));
    }
    elements.push({ path: e.name, category: cat.join("/"), order: parts.join("/"), xml: e.data.toString("utf8") });
  }
  elements.sort((a, b) => a.path.localeCompare(b.path));
  return { version: version.trim(), elements, license };
}

/* ------------------------------------------------------------------ */
/* Install                                                              */
/* ------------------------------------------------------------------ */

export type InstallResult = { libraryId: string; created: number; skipped: number; failed: number; blocks: number; version: string; ms: number };

const running = new Map<string, Promise<InstallResult>>();

/** Installs (or tops up) the standard library of a workspace. Safe to call concurrently / repeatedly. */
export function ensureStandardLibrary(workspaceId: string, opts: { ownerId?: string; log?: (m: string) => void } = {}): Promise<InstallResult> {
  const cur = running.get(workspaceId);
  if (cur) return cur;
  const p = install(workspaceId, opts).finally(() => running.delete(workspaceId));
  running.set(workspaceId, p);
  return p;
}

async function install(workspaceId: string, opts: { ownerId?: string; log?: (m: string) => void }): Promise<InstallResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const ownerId = opts.ownerId ?? (await defaultOwner(workspaceId));
  const { version, elements } = await readCollection();
  let lib = await db.library.findFirst({ where: { workspaceId, source: STANDARD_SOURCE } });
  const description = `Default symbols for electric, logic, hydraulic, pneumatic and energy drawings, plus starter circuit blocks. Collection ${version}.`;
  if (!lib) {
    lib = await db.library.create({ data: { workspaceId, name: STANDARD_LIBRARY_NAME, description, scope: "ORG", ownerId, source: STANDARD_SOURCE, license: LICENSE, attribution: ATTRIBUTION } });
  } else if (lib.description !== description) {
    lib = await db.library.update({ where: { id: lib.id }, data: { description, license: LICENSE, attribution: ATTRIBUTION } });
  }
  const have = new Set((await db.libraryElement.findMany({ where: { libraryId: lib.id, kind: "ELEMENT" }, select: { uuid: true } })).map((e) => e.uuid));
  const rows: Prisma.LibraryElementCreateManyInput[] = [];
  let skipped = 0, failed = 0;
  for (const el of elements) {
    try {
      const def = parseElmt(el.xml, { id: el.path, category: el.category });
      const uuid = def.uuid || `std:${el.path}`;
      if (have.has(uuid)) {
        skipped++;
        continue;
      }
      have.add(uuid);
      const name = (def.names.en || def.names.fr || Object.values(def.names)[0] || def.name || path.basename(el.path, ".elmt")).trim().slice(0, 200);
      const prefix = (def.prefix || guessPrefix({ ...def, category: el.category })).slice(0, 16);
      const tags = [def.kind.type, def.linkType !== "simple" ? def.linkType : ""].filter((t): t is string => !!t);
      rows.push({
        libraryId: lib.id,
        ownerId,
        kind: "ELEMENT",
        name,
        category: el.category,
        prefix,
        description: "",
        tags: JSON.stringify(tags),
        uuid,
        content: el.xml,
        meta: JSON.stringify({ __approvedRev: 1, collectionPath: el.path, order: el.order }),
        visibility: "ORG",
        status: "APPROVED",
        revision: 1,
        source: `${STANDARD_SOURCE}/${el.path}`,
        license: LICENSE,
        attribution: ATTRIBUTION,
        approvedById: ownerId,
        approvedAt: new Date(),
      });
    } catch {
      failed++;
    }
  }
  for (let i = 0; i < rows.length; i += 400) {
    await db.libraryElement.createMany({ data: rows.slice(i, i + 400) });
    log(`  standard library: ${Math.min(i + 400, rows.length)}/${rows.length}`);
  }
  // the earlier small sample library is superseded by the full collection
  await db.library.deleteMany({ where: { workspaceId, name: "QElectroTech sample elements" } });
  const blocks = await installStandardBlocks(lib.id, ownerId).catch((e) => {
    console.error("[standard-blocks]", e);
    return 0;
  });
  return { libraryId: lib.id, created: rows.length, skipped, failed, blocks, version, ms: Date.now() - t0 };
}

async function defaultOwner(workspaceId: string): Promise<string> {
  const admin = await db.membership.findFirst({ where: { workspaceId, roles: { contains: "ADMIN" } }, orderBy: { createdAt: "asc" } });
  return admin?.userId ?? "system";
}

/** Installs the standard library in every workspace (used at server start). */
export async function ensureStandardLibraryEverywhere(log?: (m: string) => void) {
  const { ensureDefaultWorkspace } = await import("@/lib/membership");
  await ensureDefaultWorkspace();
  const version = (await readFile(path.join(seedDir(), "elements.version"), "utf8").catch(() => "")).trim();
  for (const ws of await db.workspace.findMany({ select: { id: true, name: true } })) {
    const lib = await db.library.findFirst({ where: { workspaceId: ws.id, source: STANDARD_SOURCE }, select: { id: true, description: true } });
    const count = lib ? await db.libraryElement.count({ where: { libraryId: lib.id } }) : 0;
    if (lib && count > 8000 && lib.description.includes(version)) continue;
    const r = await ensureStandardLibrary(ws.id, { log });
    log?.(`standard library for ${ws.name}: +${r.created} elements, ${r.blocks} blocks in ${r.ms} ms`);
  }
}
