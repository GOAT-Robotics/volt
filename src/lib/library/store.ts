import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { Library, LibraryElement } from "@prisma/client";
import { db, J } from "@/lib/db";
import { parseElmt, serializeElmt } from "@/core/qet/elmt";
import type { ElementDef } from "@/core/model";
import { categoryFromPath, guessPrefix, newUuid, normCategory, slugify } from "./elmt-tools";

export const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
export const MAX_IMPORT_FILES = 5000;

export type NewElement = {
  libraryId: string;
  ownerId: string;
  kind?: "ELEMENT" | "BLOCK";
  name: string;
  category?: string;
  prefix?: string;
  description?: string;
  tags?: string[];
  uuid: string;
  content: string;
  meta?: Record<string, unknown>;
  visibility?: string;
  status?: string;
  source?: string | null;
  license?: string | null;
  attribution?: string | null;
  note?: string;
  approvedById?: string | null;
  approvedAt?: Date | null;
};

export async function createElementRecord(n: NewElement): Promise<LibraryElement> {
  return db.$transaction(async (tx) => {
    const el = await tx.libraryElement.create({
      data: {
        libraryId: n.libraryId,
        ownerId: n.ownerId,
        kind: n.kind ?? "ELEMENT",
        name: n.name.slice(0, 200),
        category: normCategory(n.category),
        prefix: (n.prefix ?? "").slice(0, 16),
        description: n.description ?? "",
        tags: JSON.stringify(n.tags ?? []),
        uuid: n.uuid,
        content: n.content,
        meta: JSON.stringify(n.meta ?? {}),
        visibility: n.visibility ?? "PRIVATE",
        status: n.status ?? "DRAFT",
        revision: 1,
        source: n.source ?? null,
        license: n.license ?? null,
        attribution: n.attribution ?? null,
        approvedById: n.approvedById ?? null,
        approvedAt: n.approvedAt ?? null,
      },
    });
    await tx.libraryElementRevision.create({ data: { elementId: el.id, revision: 1, content: n.content, meta: JSON.stringify(n.meta ?? {}), note: n.note ?? "Created", userId: n.ownerId } });
    return el;
  });
}

/** Append a new content revision. */
export async function addRevision(el: LibraryElement, content: string, userId: string, note: string, extra: Partial<Pick<LibraryElement, "name" | "category" | "prefix" | "description" | "tags" | "meta" | "status" | "uuid">> = {}) {
  const revision = el.revision + 1;
  return db.$transaction(async (tx) => {
    // bulk-installed elements (standard library) have no stored row for their current revision yet
    const cur = await tx.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: el.id, revision: el.revision } } });
    if (!cur) await tx.libraryElementRevision.create({ data: { elementId: el.id, revision: el.revision, content: el.content, meta: el.meta, note: "Installed", userId: el.ownerId } });
    const upd = await tx.libraryElement.update({ where: { id: el.id }, data: { content, revision, ...extra } });
    await tx.libraryElementRevision.create({ data: { elementId: el.id, revision, content, meta: extra.meta ?? el.meta, note: note.slice(0, 500), userId } });
    return upd;
  });
}

/** Parse + validate .elmt XML. Throws with a readable message. */
export function checkElmt(xml: string, path = "element"): ElementDef {
  let def: ElementDef;
  try {
    def = parseElmt(xml, { id: path });
  } catch (e) {
    throw new Error(`${path}: not a valid element file (${(e as Error).message.slice(0, 160)})`);
  }
  if (!def.prims.length && !def.pins.length) throw new Error(`${path}: the element has no drawing and no terminals`);
  return def;
}

export type ImportEntry = { path: string; data: Uint8Array };
export type ImportOptions = {
  library: Library;
  ownerId: string;
  visibility?: string;
  status?: string;
  onDuplicate?: "skip" | "copy" | "update";
  categoryPrefix?: string;
  note?: string;
  approvedById?: string | null;
};
export type ImportResult = { created: number; skipped: number; updated: number; errors: string[]; ids: string[] };

/** Expand .zip entries into .elmt entries (keeping folder paths); ignores qet_directory & junk. */
export function expandEntries(files: ImportEntry[]): { entries: ImportEntry[]; errors: string[]; dirNames: Map<string, string> } {
  const entries: ImportEntry[] = [];
  const errors: string[] = [];
  const dirNames = new Map<string, string>();
  const take = (path: string, data: Uint8Array) => {
    const p = path.replace(/\\/g, "/");
    if (/(^|\/)(__MACOSX|\.)/.test(p)) return;
    const base = p.split("/").pop() ?? "";
    if (base === "qet_directory") {
      const n = /<name\s+lang="en">([^<]*)<\/name>/.exec(strFromU8(data))?.[1];
      if (n) dirNames.set(categoryFromPath(p), n.trim());
      return;
    }
    if (/\.elmt$/i.test(base)) entries.push({ path: p, data });
    else if (/\.zip$/i.test(base)) {
      try {
        const inner = Object.entries(unzipSync(data)).filter(([k]) => !k.endsWith("/") && !/(^|\/)(__MACOSX|\.)/.test(k));
        const prefix = categoryFromPath(p);
        // a single wrapper folder (e.g. "my_collection/…") is the archive itself, not a category
        const tops = new Set(inner.map(([k]) => (k.includes("/") ? k.split("/")[0] : "")));
        const wrap = tops.size === 1 ? [...tops][0] : "";
        for (const [k, v] of inner) take((prefix ? prefix + "/" : "") + (wrap ? k.slice(wrap.length + 1) : k), v);
      } catch (e) {
        errors.push(`${p}: could not read ZIP archive (${(e as Error).message})`);
      }
    }
  };
  for (const f of files) {
    if (entries.length > MAX_IMPORT_FILES) {
      errors.push(`Too many files — only the first ${MAX_IMPORT_FILES} were processed`);
      break;
    }
    take(f.path, f.data);
  }
  return { entries, errors, dirNames };
}

/** Strip a common single top-level folder ("my_collection/…") only when every entry shares it and it looks like an archive root. */
function commonRoot(paths: string[]): string {
  if (paths.length < 2) return "";
  const firsts = new Set(paths.map((p) => (p.includes("/") ? p.split("/")[0] : "")));
  if (firsts.size !== 1) return "";
  const r = [...firsts][0];
  return r && /^(elements|collection|custom|import|qet)/i.test(r) ? r : "";
}

export async function importElmts(files: ImportEntry[], o: ImportOptions): Promise<ImportResult> {
  const { entries, errors, dirNames } = expandEntries(files);
  const res: ImportResult = { created: 0, skipped: 0, updated: 0, errors, ids: [] };
  const root = commonRoot(entries.map((e) => e.path));
  const existing = await db.libraryElement.findMany({ where: { ownerId: o.ownerId, kind: "ELEMENT", library: { workspaceId: o.library.workspaceId } }, select: { id: true, uuid: true, content: true, revision: true } });
  const byUuid = new Map(existing.map((e) => [e.uuid, e]));
  const seenInBatch = new Set<string>();
  for (const e of entries) {
    const rel = root && e.path.startsWith(root + "/") ? e.path.slice(root.length + 1) : e.path;
    let xml: string;
    try {
      xml = strFromU8(e.data);
    } catch {
      res.errors.push(`${e.path}: not UTF-8 text`);
      continue;
    }
    let def: ElementDef;
    try {
      def = checkElmt(xml, rel);
    } catch (err) {
      res.errors.push((err as Error).message);
      continue;
    }
    const folder = categoryFromPath(rel);
    const segs = folder ? folder.split("/") : [];
    const named = segs.map((seg, i) => dirNames.get(segs.slice(0, i + 1).join("/")) ?? dirNames.get([root, ...segs.slice(0, i + 1)].filter(Boolean).join("/")) ?? seg);
    const cat = normCategory([o.categoryPrefix ?? "", ...named].filter(Boolean).join("/"));
    const name = def.names.en || def.name || rel.split("/").pop()!.replace(/\.elmt$/i, "");
    let uuid = def.uuid || "";
    const dup = uuid ? byUuid.get(uuid) : undefined;
    if (uuid && (dup || seenInBatch.has(uuid))) {
      const mode = o.onDuplicate ?? "skip";
      if (mode === "skip" || (!dup && seenInBatch.has(uuid))) {
        res.skipped++;
        continue;
      }
      if (mode === "update" && dup) {
        if (dup.content === xml) {
          res.skipped++;
          continue;
        }
        const full = await db.libraryElement.findUniqueOrThrow({ where: { id: dup.id } });
        await addRevision(full, xml, o.ownerId, o.note ?? `Re-imported from ${rel}`);
        res.updated++;
        res.ids.push(dup.id);
        continue;
      }
      // copy: new identity
      uuid = newUuid();
      xml = serializeElmt({ ...def, uuid });
    }
    if (!uuid) {
      uuid = newUuid();
      xml = serializeElmt({ ...def, uuid });
    }
    seenInBatch.add(def.uuid || uuid);
    const informations = def.meta.informations ?? "";
    const lic = /licen[cs]e\s*:\s*(.+)/i.exec(informations)?.[1]?.trim();
    const author = /author\s*:\s*(.+)/i.exec(informations)?.[1]?.trim();
    try {
      const el = await createElementRecord({
        libraryId: o.library.id,
        ownerId: o.ownerId,
        name,
        category: cat,
        prefix: def.prefix || guessPrefix({ ...def, category: cat }),
        description: "",
        tags: [def.kind.type, def.linkType !== "simple" ? def.linkType : ""].filter(Boolean) as string[],
        uuid,
        content: xml,
        meta: author ? { author } : {},
        visibility: o.visibility ?? "PRIVATE",
        status: o.status ?? "DRAFT",
        source: o.library.source ?? `import:${rel}`,
        license: o.library.license ?? lic ?? null,
        attribution: o.library.attribution ?? author ?? null,
        note: o.note ?? `Imported from ${rel}`,
        approvedById: o.approvedById ?? null,
        approvedAt: o.approvedById ? new Date() : null,
      });
      byUuid.set(uuid, { id: el.id, uuid, content: xml, revision: 1 });
      res.created++;
      res.ids.push(el.id);
    } catch (err) {
      res.errors.push(`${rel}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return res;
}

/** File name for an element in an archive. */
export function elmtFileName(el: Pick<LibraryElement, "name" | "id">): string {
  return `${slugify(el.name)}.elmt`;
}

const qetDirectory = (name: string) =>
  `<qet-directory>\n    <names>\n        <name lang="en">${name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</name>\n    </names>\n</qet-directory>\n`;

/** Build a QET-collection style ZIP (category folders with qet_directory files). */
export function buildZip(items: Pick<LibraryElement, "id" | "name" | "category" | "content" | "kind">[], rootName = "volt_library"): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const dirs = new Set<string>();
  const root = slugify(rootName);
  dirs.add(root);
  for (const it of items) {
    if (it.kind !== "ELEMENT") continue;
    const cat = normCategory(it.category);
    const folder = [root, ...cat.split("/").filter(Boolean)].join("/");
    const segs = folder.split("/");
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
    let fn = `${folder}/${elmtFileName(it)}`;
    let k = 2;
    while (files[fn]) fn = `${folder}/${slugify(it.name)}_${k++}.elmt`;
    files[fn] = strToU8(it.content);
  }
  for (const d of dirs) files[`${d}/qet_directory`] = strToU8(qetDirectory(d === root ? rootName : d.split("/").pop()!));
  return zipSync(files, { level: 6 });
}

export function metaOf(el: Pick<LibraryElement, "meta">) {
  return J.parse<Record<string, unknown>>(el.meta, {});
}
