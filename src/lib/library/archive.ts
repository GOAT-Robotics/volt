/** Archive expansion for library imports, with zip-bomb limits (no server dependencies). */
import { unzipSync, strFromU8 } from "fflate";
import { categoryFromPath } from "./elmt-tools";
import { MAX_IMPORT_FILES } from "./limits";

export type ImportEntry = { path: string; data: Uint8Array };

/** Expand .zip entries into .elmt entries (keeping folder paths); ignores qet_directory & junk. */
export function expandEntries(files: ImportEntry[]): { entries: ImportEntry[]; errors: string[]; dirNames: Map<string, string> } {
  const entries: ImportEntry[] = [];
  const errors: string[] = [];
  const dirNames = new Map<string, string>();
  // zip-bomb guards: one budget for the whole request, per-file cap, one level of nested archives
  let budget = MAX_UNZIPPED_BYTES;
  let count = 0;
  const take = (path: string, data: Uint8Array, depth: number) => {
    const p = path.replace(/\\/g, "/");
    if (/(^|\/)(__MACOSX|\.)/.test(p)) return;
    const base = p.split("/").pop() ?? "";
    if (base === "qet_directory") {
      const n = /<name\s+lang="en">([^<]*)<\/name>/.exec(strFromU8(data))?.[1];
      if (n) dirNames.set(categoryFromPath(p), n.trim());
      return;
    }
    if (/\.elmt$/i.test(base)) {
      if (++count > MAX_IMPORT_FILES) throw new ImportLimit(`Too many files — at most ${MAX_IMPORT_FILES} elements per import`);
      entries.push({ path: p, data });
    } else if (/\.zip$/i.test(base)) {
      if (depth >= 2) return void errors.push(`${p}: archives inside archives inside archives are not imported`);
      try {
        const inner = Object.entries(
          unzipSync(data, {
            filter: (f) => {
              if (!/\.(elmt|zip)$|(^|\/)qet_directory$/i.test(f.name) || /(^|\/)(__MACOSX|\.)/.test(f.name)) return false;
              if (f.originalSize > MAX_ENTRY_BYTES) {
                errors.push(`${p}/${f.name}: larger than ${MAX_ENTRY_BYTES / 1e6} MB, skipped`);
                return false;
              }
              budget -= f.originalSize;
              if (budget < 0) throw new ImportLimit(`The archive unpacks to more than ${MAX_UNZIPPED_BYTES / 1e6} MB`);
              return true;
            },
          }),
        ).filter(([k]) => !k.endsWith("/"));
        const prefix = categoryFromPath(p);
        // a single wrapper folder (e.g. "my_collection/…") is the archive itself, not a category
        const tops = new Set(inner.map(([k]) => (k.includes("/") ? k.split("/")[0] : "")));
        const wrap = tops.size === 1 ? [...tops][0] : "";
        for (const [k, v] of inner) take((prefix ? prefix + "/" : "") + (wrap ? k.slice(wrap.length + 1) : k), v, depth + 1);
      } catch (e) {
        if (e instanceof ImportLimit) throw e;
        errors.push(`${p}: could not read ZIP archive (${(e as Error).message})`);
      }
    }
  };
  try {
    for (const f of files) take(f.path, f.data, 0);
  } catch (e) {
    if (!(e instanceof ImportLimit)) throw e;
    errors.push(e.message);
  }
  return { entries, errors, dirNames };
}

class ImportLimit extends Error {}
/** total uncompressed size of all archives in one import */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
/** one element file */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

