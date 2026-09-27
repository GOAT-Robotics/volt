/**
 * Standard library: the complete default element collection (≈8,800 symbols across electric, logic,
 * hydraulic, pneumatic and energy) plus a starter set of reusable circuit blocks.
 *
 * The collection ships with Volt as seed/elements.tgz and is installed into every workspace
 * automatically (server start and `npm run db:seed`). Installing is idempotent: elements are matched
 * by uuid, so re-running after a collection update only adds what is new.
 */
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
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
/* Streaming tar reader                                                 */
/* ------------------------------------------------------------------ */

type TarEntry = { name: string; data: Buffer };

/**
 * Streams entries out of a .tgz without ever holding the whole archive (≈110 MB unpacked) in
 * memory. `want` decides per file name whether its data is needed; skipped files are not buffered.
 */
export async function* streamTgz(file: string, want: (name: string) => boolean = () => true): AsyncGenerator<TarEntry> {
  const gz = createReadStream(file).pipe(createGunzip());
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  // current entry being read
  let cur: { name: string; size: number; keep: boolean; parts: Buffer[]; got: number; pad: number } | null = null;
  const str = (h: Buffer, a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
  for await (const chunk of gz as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (cur) {
        const need = cur.size - cur.got;
        const take = Math.min(need, buf.length - off);
        if (take > 0) {
          if (cur.keep) cur.parts.push(buf.subarray(off, off + take));
          cur.got += take;
          off += take;
        }
        if (cur.got < cur.size) break;
        if (buf.length - off < cur.pad) break;
        off += cur.pad;
        const done = cur;
        cur = null;
        if (done.keep) {
          const data = Buffer.concat(done.parts);
          if (done.name === "\0L") longName = data.toString("utf8").replace(/\0.*$/s, "");
          else yield { name: done.name, data };
        }
        continue;
      }
      if (buf.length - off < 512) break;
      const h = buf.subarray(off, off + 512);
      off += 512;
      if (h.every((b) => b === 0)) continue;
      let name = str(h, 0, 100);
      const size = parseInt(str(h, 124, 136).trim() || "0", 8);
      const type = String.fromCharCode(h[156] || 48);
      const prefix = str(h, 345, 500);
      if (prefix) name = prefix + "/" + name;
      const pad = (512 - (size % 512)) % 512;
      if (type === "L") {
        cur = { name: "\0L", size, keep: true, parts: [], got: 0, pad };
        continue;
      }
      if (longName) {
        name = longName;
        longName = null;
      }
      name = name.replace(/^\.\//, "");
      const isFile = type === "0" || type === "\0" || type === "7";
      cur = { name, size, keep: isFile && want(name), parts: [], got: 0, pad };
    }
    // keep only the unread tail; copy so the big chunk can be collected
    buf = off >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(off));
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

const tgzPath = () => path.join(seedDir(), "elements.tgz");
export const collectionVersion = async () => (await readFile(path.join(seedDir(), "elements.version"), "utf8").catch(() => "unknown")).trim();

/** English category names of every folder (first, cheap pass: only the small qet_directory files are kept). */
async function readDirNames(): Promise<Map<string, string>> {
  const dirNames = new Map<string, string>();
  for await (const e of streamTgz(tgzPath(), (n) => n.endsWith("/qet_directory") || n === "qet_directory")) {
    const d = e.name.slice(0, -"/qet_directory".length);
    dirNames.set(d, dirName(e.data.toString("utf8"), d.split("/").pop() ?? d));
  }
  return dirNames;
}

function categoryOf(file: string, dirNames: Map<string, string>): { category: string; order: string } {
  const parts = file.split("/").slice(0, -1);
  const cat: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const d = parts.slice(0, i).join("/");
    cat.push((dirNames.get(d) ?? humanize(parts[i - 1])).replace(/\//g, "-"));
  }
  return { category: cat.join("/"), order: parts.join("/") };
}

/** Streams every .elmt of the bundled collection with its English category path. */
export async function* streamCollection(): AsyncGenerator<StandardElement> {
  const dirNames = await readDirNames();
  for await (const e of streamTgz(tgzPath(), (n) => n.endsWith(".elmt"))) yield { path: e.name, ...categoryOf(e.name, dirNames), xml: e.data.toString("utf8") };
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
  const version = await collectionVersion();
  let lib = await db.library.findFirst({ where: { workspaceId, source: STANDARD_SOURCE } });
  const description = `Default symbols for electric, logic, hydraulic, pneumatic and energy drawings, plus starter circuit blocks. Collection ${version}.`;
  if (!lib) {
    lib = await db.library.create({ data: { workspaceId, name: STANDARD_LIBRARY_NAME, description, scope: "ORG", ownerId, source: STANDARD_SOURCE, license: LICENSE, attribution: ATTRIBUTION } });
  }
  const libraryId = lib.id;
  const have = new Set((await db.libraryElement.findMany({ where: { libraryId, kind: "ELEMENT" }, select: { uuid: true } })).map((e) => e.uuid));
  // Elements are parsed and inserted in small batches straight off the archive stream, so memory
  // stays flat (a few MB of rows) instead of holding the whole collection at once.
  const BATCH = 200;
  let rows: Prisma.LibraryElementCreateManyInput[] = [];
  let created = 0, skipped = 0, failed = 0;
  const flush = async () => {
    if (!rows.length) return;
    await db.libraryElement.createMany({ data: rows });
    created += rows.length;
    rows = [];
    if (created % 1000 < BATCH) log(`  standard library: ${created} elements added`);
  };
  for await (const el of streamCollection()) {
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
        libraryId,
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
      if (rows.length >= BATCH) await flush();
    } catch {
      failed++;
    }
  }
  await flush();
  // the description carries the collection version: only marked current once everything is in
  if (lib.description !== description) await db.library.update({ where: { id: libraryId }, data: { description, license: LICENSE, attribution: ATTRIBUTION } });
  // the earlier small sample library is superseded by the full collection
  await db.library.deleteMany({ where: { workspaceId, name: "QElectroTech sample elements" } });
  const blocks = await installStandardBlocks(libraryId, ownerId).catch((e) => {
    console.error("[standard-blocks]", e);
    return 0;
  });
  return { libraryId, created, skipped, failed, blocks, version, ms: Date.now() - t0 };
}

async function defaultOwner(workspaceId: string): Promise<string> {
  const admin = await db.membership.findFirst({ where: { workspaceId, roles: { contains: "ADMIN" } }, orderBy: { createdAt: "asc" } });
  return admin?.userId ?? "system";
}

/** Installs the standard library in every workspace (used at server start). */
export async function ensureStandardLibraryEverywhere(log?: (m: string) => void) {
  const { ensureDefaultWorkspace } = await import("@/lib/membership");
  await ensureDefaultWorkspace();
  const version = await collectionVersion();
  for (const ws of await db.workspace.findMany({ select: { id: true, name: true } })) {
    const lib = await db.library.findFirst({ where: { workspaceId: ws.id, source: STANDARD_SOURCE }, select: { id: true, description: true } });
    const count = lib ? await db.libraryElement.count({ where: { libraryId: lib.id } }) : 0;
    if (lib && count > 8000 && lib.description.includes(version)) continue;
    const r = await ensureStandardLibrary(ws.id, { log });
    log?.(`standard library for ${ws.name}: +${r.created} elements, ${r.blocks} blocks in ${r.ms} ms`);
  }
}
