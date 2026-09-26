/**
 * Seeds the organisation library with the QElectroTech sample elements shipped as test fixtures.
 * Idempotent: the library is found by name, elements by uuid.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { parseElmt } from "@/core/qet/elmt";
import { createElementRecord } from "./store";
import { guessPrefix, normCategory } from "./elmt-tools";

export const SAMPLE_LIBRARY_NAME = "QElectroTech sample elements";

const TYPE_CATEGORY: Record<string, string> = {
  coil: "Relays & contactors/Coils",
  protection: "Protection",
  commutator: "Switching",
  thumbnail: "Other",
};

function categoryFor(file: string, def: ReturnType<typeof parseElmt>): string {
  const t = (def.kind.type ?? "").toLowerCase();
  if (TYPE_CATEGORY[t]) return TYPE_CATEGORY[t];
  const n = `${file} ${def.names.en ?? ""} ${def.names.fr ?? ""}`.toLowerCase();
  if (def.linkType === "next_report" || def.linkType === "previous_report" || /arrow|report|renvoi/.test(n)) return "Folio references";
  if (def.linkType === "terminal" || /terminal|barette|borne/.test(n)) return "Terminals & connectors";
  if (/motor|moteur|brzda|choke/.test(n)) return "Motors & drives";
  if (/lamp|clignot|sonnerie|bell|ihm|screen|ecran|hmi/.test(n)) return "Signalling & HMI";
  if (/diode|schottky|ntc|condensat|capacitor|ddr|tmr/.test(n)) return "Electronics";
  if (/disjonct|sectionneur|fusible|dis_mag|inter|odpinac|breaker/.test(n)) return "Protection & isolation";
  if (/poussoir|push|contatti|comm|com_|bod|contact/.test(n)) return "Switching";
  if (def.linkType === "master") return "Relays & contactors/Coils";
  if (def.linkType === "slave") return "Relays & contactors/Contacts";
  return "Other";
}

function fixturesDir(): string {
  return path.join(process.cwd(), "src", "core", "qet", "__fixtures__", "elements");
}

export async function seedLibrary(workspaceId: string, ownerId: string): Promise<{ libraryId: string; created: number; existing: number; errors: string[] }> {
  let lib = await db.library.findFirst({ where: { workspaceId, name: SAMPLE_LIBRARY_NAME } });
  const libData = {
    description: "Sample symbols from the QElectroTech elements collection, imported for reuse across the organization.",
    scope: "ORG",
    source: "https://github.com/qelectrotech/qelectrotech-elements",
    license: "CC-BY 3.0 / QElectroTech collection",
    attribution: "The QElectroTech team and contributors — https://qelectrotech.org",
  };
  if (!lib) lib = await db.library.create({ data: { workspaceId, name: SAMPLE_LIBRARY_NAME, ownerId, ...libData } });
  const dir = fixturesDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".elmt")).sort();
  const existing = await db.libraryElement.findMany({ where: { libraryId: lib.id }, select: { uuid: true } });
  const have = new Set(existing.map((e) => e.uuid));
  let created = 0;
  const errors: string[] = [];
  for (const f of files) {
    try {
      const xml = await readFile(path.join(dir, f), "utf8");
      const def = parseElmt(xml, { id: f });
      const uuid = def.uuid || `fixture:${f}`;
      if (have.has(uuid)) continue;
      const category = normCategory(categoryFor(f, def));
      await createElementRecord({
        libraryId: lib.id,
        ownerId,
        name: def.names.en || def.name || f.replace(/\.elmt$/, ""),
        category,
        prefix: def.prefix || guessPrefix({ ...def, category }),
        description: `QElectroTech sample element (${f}).`,
        tags: ["qelectrotech", def.kind.type, def.linkType !== "simple" ? def.linkType : ""].filter(Boolean) as string[],
        uuid,
        content: xml,
        meta: { __approvedRev: 1, sourceFile: f },
        visibility: "ORG",
        status: "APPROVED",
        source: `${libData.source}/${f}`,
        license: libData.license,
        attribution: libData.attribution,
        note: "Seeded from QElectroTech sample collection",
        approvedById: ownerId,
        approvedAt: new Date(),
      });
      have.add(uuid);
      created++;
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { libraryId: lib.id, created, existing: existing.length, errors };
}
