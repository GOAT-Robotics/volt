import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseTitleBlockTemplate } from "@/core/qet/titleblock";
import type { TitleBlockTemplate } from "@/core/model";
import { seedDir } from "@/lib/library/standard";

let cache: Promise<TitleBlockTemplate[]> | null = null;

/** Standard title block templates shipped with Volt (seed/titleblocks). */
export function standardTitleBlocks(): Promise<TitleBlockTemplate[]> {
  cache ??= (async () => {
    const dir = path.join(seedDir(), "titleblocks");
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".titleblock")).sort();
    const out: TitleBlockTemplate[] = [];
    for (const f of files) {
      try {
        const t = parseTitleBlockTemplate(await readFile(path.join(dir, f), "utf8"));
        if (t.name === "default") continue; // Volt's built-in default is used instead
        out.push(t);
      } catch {
        /* skip unreadable template */
      }
    }
    return out;
  })();
  return cache;
}
