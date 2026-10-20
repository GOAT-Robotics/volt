/**
 * MCP tools for project-level work: project record and drawing settings, terminal strips,
 * reusable blocks and the library (placing blocks, saving symbols and blocks, updating to newer
 * library revisions).
 */
import "server-only";
import { z } from "zod";
import { db } from "../db";
import { audit } from "../audit";
import { loadElement, assertMember, writableLibrary, tagsIn } from "../library/access";
import { createElementRecord } from "../library/store";
import { newUuid, normCategory, guessPrefix } from "../library/elmt-tools";
import { serializeElmt } from "@/core/qet/elmt";
import { buildBlock, detachGroup, mergeToDef, placeBlock, updateBlockInstance } from "@/core/blocks";
import { updateInstancesDef } from "@/core/replace";
import { getPage, mkSel } from "@/core/ops";
import type { BlockContent, Doc } from "@/core/model";
import { editStrip, placeStripTerminals, settingsText, SETTINGS_SECTIONS, stripsText, updateSettings, type SettingsSection } from "./project";
import { findComponents, findPage, positionOf, refOf, sheetNo } from "./doc";
import { partsOf } from "./edits";
import { assertCanEdit, component, editDrawing, findProject, guard, libraryDef, page, plural, readVersion, symbolFor, tool, ToolError, version, via, type Env, type Tool } from "./kit";

const sections = z.array(z.enum(SETTINGS_SECTIONS)).optional().describe(`Only these: ${SETTINGS_SECTIONS.join(", ")} (default all)`);

/** a library block the person may use: content at the revision they may see */
async function libraryBlock(env: Env, id: string): Promise<{ id: string; name: string; revision: number; content: BlockContent }> {
  assertMember(env.ctx);
  const acc = await loadElement(env.ctx, id).catch(() => null);
  if (!acc) throw new ToolError(`No library block ${id} — search_library kind: block`);
  if (acc.el.kind !== "BLOCK") throw new ToolError("That library item is a single symbol — use place_component");
  let content = acc.el.content;
  let rev = acc.el.revision;
  if (acc.viewerRevision !== acc.el.revision) {
    const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: acc.el.id, revision: acc.viewerRevision } } });
    if (r) ((content = r.content), (rev = r.revision));
  }
  return { id: acc.el.id, name: acc.el.name, revision: rev, content: JSON.parse(content) as BlockContent };
}

/** the block instance a component belongs to */
function groupOf(doc: Doc, ref: string) {
  const x = findComponents(doc, ref)[0];
  if (!x.e.group) throw new ToolError(`${refOf(doc, x)} is not part of a placed block`);
  return { page: x.page, group: x.e.group };
}

export const PROJECT_TOOLS: Tool[] = [
  /* ---------------------------------- project and settings ---------------------------------- */
  tool({
    name: "update_project",
    title: "Project name, number, description, tags",
    area: "Project settings",
    description: "Change the project record (project owners): name (also the drawing title %projecttitle of the working version), number, description, tags.",
    access: "edit",
    input: z.object({ project: z.string(), name: z.string().min(1).max(200).optional(), number: z.string().max(60).optional(), description: z.string().max(4000).optional(), tags: z.array(z.string().max(40)).max(30).optional() }),
    run: async (x, env) => {
      assertCanEdit(env, "change projects");
      const { project, can } = await findProject(env.ctx, x.project);
      if (!can("project.manage")) throw new ToolError("Only project owners can change the project record");
      if (x.number && x.number !== project.number && (await db.project.findFirst({ where: { workspaceId: project.workspaceId, number: x.number, id: { not: project.id } } }))) throw new ToolError(`Project number ${x.number} is already used`);
      const data = { ...(x.name !== undefined && { name: x.name.trim() }), ...(x.number !== undefined && { number: x.number.trim() || null }), ...(x.description !== undefined && { description: x.description }), ...(x.tags !== undefined && { tags: JSON.stringify([...new Set(x.tags)]) }) };
      if (!Object.keys(data).length) throw new ToolError("Nothing to change");
      await db.project.update({ where: { id: project.id }, data });
      await audit({ workspaceId: project.workspaceId, projectId: project.id, actorId: env.ctx.user.id, type: "project.update", data: { ...data, via: via(env) } });
      let title = "";
      if (x.name) {
        const working = await db.version.findFirst({ where: { projectId: project.id, variantId: null, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } }, select: { id: true } });
        if (working) title = "\n" + (await editDrawing(env, working.id, "update_project", (d) => ((d.meta.title = x.name!.trim()), `Drawing title "${x.name!.trim()}"`)).catch((e) => `(drawing title not changed: ${(e as Error).message})`));
      }
      return `Project ${project.number ?? project.id}: ${Object.entries(data).map(([k, v]) => `${k}=${v ?? "(none)"}`).join("; ")}${title}`;
    },
  }),
  tool({
    name: "get_settings",
    title: "Project settings",
    area: "Project settings",
    description: "The drawing's settings: project properties (%variables), revision history, reference numbering rules, wire numbering (format, supplies / wire classes with their letters), wiring display (standard, colours, sections), text and graphic styles, title block templates (their grid).",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, sections }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      return settingsText(doc, x.sections as SettingsSection[] | undefined);
    },
  }),
  tool({
    name: "update_settings",
    title: "Change project settings",
    area: "Project settings",
    description:
      "Change the drawing's settings, as the Project properties, Numbering, Wire numbering, Wiring and Global styles dialogs: drawing title; project properties (\"\" removes one); revision history (add_revision, or replace all); reference numbering rules (match = prefix or category or *, prefix, scope page/project/location, format with {prefix} {n} {n:2} {page} {location}, start), references on placing, closing gaps on delete; wire numbering (preset harness/panel/custom, format tokens {class} {n:3} {seg} {ret} {page} {col} {row} {size}, segments, return suffix, PE letter, 0 V mode, unknown-voltage letter, default supplies, start, replace rail names, and the supplies list — letter, name, kind dc/ac/signal/any, volts, use power/control, match regex; read get_settings first and send the whole list); wiring display (standard iec/nfpa/jis, show colour / section, tick, colour by function, number at middle/ends/both, destination at ends, heavier lines for larger sections); styles (text roles: font size weight italic color visible …; graphics: wire, bus, pin, outline, frame, componentInfo, border, titleBlock …; reset).",
    access: "edit",
    input: z.object({
      version,
      drawing_title: z.string().max(200).optional(),
      properties: z.record(z.string().max(60), z.string().max(1000)).optional(),
      add_revision: z.object({ rev: z.string().max(20), date: z.string().max(40), description: z.string().max(500), drawn: z.string().max(80).optional(), checked: z.string().max(80).optional(), approved: z.string().max(80).optional() }).optional(),
      revisions: z.array(z.object({ rev: z.string().max(20), date: z.string().max(40), description: z.string().max(500), drawn: z.string().max(80).optional(), checked: z.string().max(80).optional(), approved: z.string().max(80).optional() })).max(200).optional(),
      numbering: z
        .object({
          rules: z.array(z.object({ match: z.string().max(80), prefix: z.string().max(20).optional(), scope: z.enum(["page", "project", "location"]), format: z.string().max(80), start: z.number().int().min(0).optional() })).max(100).optional(),
          references_on_place: z.boolean().optional(),
          close_gaps_on_delete: z.boolean().optional(),
        })
        .optional(),
      wire_numbering: z
        .object({
          preset: z.enum(["harness", "panel", "custom"]).optional(),
          format: z.string().max(80).optional(),
          segments: z.boolean().optional(),
          return_suffix: z.string().max(8).optional(),
          pe_letter: z.string().max(8).optional(),
          gnd_mode: z.enum(["return", "letter"]).optional(),
          gnd_letter: z.string().max(8).optional(),
          fallback_letter: z.string().max(8).optional(),
          default_dc: z.string().max(40).optional(),
          default_ac: z.string().max(40).optional(),
          start: z.number().int().min(0).optional(),
          replace_potential_names: z.boolean().optional(),
          supplies: z.array(z.object({ id: z.string().max(40).optional(), letter: z.string().max(8), name: z.string().max(120), kind: z.enum(["dc", "ac", "signal", "any"]), volts: z.number().optional(), use: z.enum(["power", "control"]).optional(), match: z.string().max(400).optional() })).max(40).optional(),
        })
        .optional(),
      wiring: z
        .object({ standard: z.enum(["iec", "nfpa", "jis"]).optional(), show_colour: z.boolean().optional(), show_section: z.boolean().optional(), tick: z.boolean().optional(), colour_by_function: z.boolean().optional(), number_at: z.enum(["middle", "ends", "both"]).optional(), destination: z.boolean().optional(), weight_by_section: z.boolean().optional() })
        .optional(),
      styles: z.object({ text: z.record(z.string(), z.record(z.string(), z.unknown())).optional(), graphics: z.record(z.string(), z.unknown()).optional(), reset: z.boolean().optional() }).optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "update_settings", (d) =>
        guard(() =>
          updateSettings(d, {
            drawingTitle: x.drawing_title,
            properties: x.properties,
            addRevision: x.add_revision,
            revisions: x.revisions,
            numbering: x.numbering ? { rules: x.numbering.rules?.map((r) => ({ ...r, prefix: r.prefix ?? "", start: r.start ?? 1 })), autoOnPlace: x.numbering.references_on_place, closeGapsOnDelete: x.numbering.close_gaps_on_delete } : undefined,
            wireNumbering: x.wire_numbering
              ? {
                  preset: x.wire_numbering.preset,
                  format: x.wire_numbering.format,
                  segments: x.wire_numbering.segments,
                  returnSuffix: x.wire_numbering.return_suffix,
                  peLetter: x.wire_numbering.pe_letter,
                  gndMode: x.wire_numbering.gnd_mode,
                  gndLetter: x.wire_numbering.gnd_letter,
                  fallbackLetter: x.wire_numbering.fallback_letter,
                  defaultDc: x.wire_numbering.default_dc,
                  defaultAc: x.wire_numbering.default_ac,
                  start: x.wire_numbering.start,
                  replacePotentialNames: x.wire_numbering.replace_potential_names,
                  classes: x.wire_numbering.supplies,
                }
              : undefined,
            wiring: x.wiring ? { standard: x.wiring.standard, showColor: x.wiring.show_colour, showSection: x.wiring.show_section, tick: x.wiring.tick, colorize: x.wiring.colour_by_function, numberAt: x.wiring.number_at, destination: x.wiring.destination, weightBySection: x.wiring.weight_by_section } : undefined,
            styles: x.styles as never,
          }),
        ),
      ),
  }),

  /* ---------------------------------- terminal strips ---------------------------------- */
  tool({
    name: "get_terminal_strips",
    title: "Terminal strips",
    area: "Terminals",
    description: "Terminal strips (X1, X2 …) in order: each terminal's number, type (feed, pe, neutral, fuse, disconnect, diode, sensor, multi), level, bridge to the next, what it connects on each side, part number, sheets, note — the terminal plan. Spare terminals are on the rail but not drawn.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, strip: z.string().optional() }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      return stripsText(doc, x.strip);
    },
  }),
  tool({
    name: "edit_terminal_strip",
    title: "Edit a terminal strip",
    area: "Terminals",
    description: "The terminal strip editor: create a strip (count, start), rename it (references follow), separator, description, location, default part number / manufacturer; set the order (terminal numbers top to bottom), sort by number, renumber (start, step, zero padding, prefix); per terminal: new number, type, level, bridge to the next, part number, note; add spare terminals (after a terminal), remove spares; move terminals to another strip (they get its next numbers); delete an empty strip. Unnumbered terminals are addressed by #id.",
    access: "edit",
    input: z.object({
      version,
      strip: z.string().describe('Strip tag, e.g. "X1" ("" = terminals without a strip)'),
      create: z.object({ count: z.number().int().min(1).max(500), start: z.number().int().min(0).optional() }).optional(),
      rename: z.string().max(40).optional(),
      separator: z.enum([":", "-", "."]).optional(),
      description: z.string().max(300).optional(),
      location: z.string().max(100).optional(),
      part_number: z.string().max(200).optional(),
      manufacturer: z.string().max(200).optional(),
      order: z.array(z.string()).max(1000).optional(),
      sort_by_number: z.boolean().optional(),
      renumber: z.object({ start: z.number().int().optional(), step: z.number().int().min(1).optional(), pad: z.number().int().min(0).max(6).optional(), prefix: z.string().max(10).optional() }).optional(),
      terminals: z
        .array(z.object({ terminal: z.string(), number: z.string().max(20).optional(), type: z.enum(["feed", "pe", "neutral", "fuse", "disconnect", "diode", "sensor", "multi", ""]).optional(), level: z.number().int().min(1).max(5).nullable().optional(), bridge: z.boolean().optional(), part_number: z.string().max(200).optional(), note: z.string().max(300).optional() }))
        .max(1000)
        .optional(),
      add_spares: z.object({ count: z.number().int().min(1).max(200), after: z.string().optional() }).optional(),
      remove_spares: z.array(z.string()).max(500).optional(),
      move_terminals: z.object({ terminals: z.array(z.string()).min(1).max(500), to_strip: z.string() }).optional(),
      delete: z.boolean().optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "edit_terminal_strip", (d) =>
        guard(() =>
          editStrip(d, x.strip, {
            create: x.create,
            rename: x.rename,
            separator: x.separator,
            description: x.description,
            location: x.location,
            partNumber: x.part_number,
            manufacturer: x.manufacturer,
            order: x.order,
            sortByNumber: x.sort_by_number,
            renumber: x.renumber,
            rows: x.terminals?.map((t) => ({ terminal: t.terminal, number: t.number, type: t.type, level: t.level, bridge: t.bridge, partNumber: t.part_number, note: t.note })),
            addSpares: x.add_spares,
            removeSpares: x.remove_spares,
            moveTerminals: x.move_terminals ? { terminals: x.move_terminals.terminals, toStrip: x.move_terminals.to_strip } : undefined,
            delete: x.delete,
          }),
        ),
      ),
  }),
  tool({
    name: "place_terminals",
    title: "Draw terminals of a strip",
    area: "Terminals",
    description: "Draw terminals of a strip on a sheet: side by side (h, default) or one under the other (v), from a cell / point or in a free area below what is drawn. Default: the strip's terminals that are not drawn yet (spares). The symbol: the strip's usual terminal symbol, or library_id / like.",
    access: "edit",
    input: z.object({ version, strip: z.string(), page, terminals: z.array(z.string()).max(500).optional(), direction: z.enum(["h", "v"]).optional(), cell: z.string().optional(), x: z.number().optional(), y: z.number().optional(), library_id: z.string().optional(), like: z.string().optional() }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const def = x.library_id || x.like ? await symbolFor(env, doc, x) : undefined;
      return editDrawing(env, x.version, "place_terminals", (d) =>
        guard(() => placeStripTerminals(d, x.strip, x.page, { terminals: x.terminals, direction: x.direction, at: x.cell || (x.x !== undefined && x.y !== undefined) ? { cell: x.cell, x: x.x, y: x.y } : undefined, def: def ? (d.defs[def.id] ?? structuredClone(def)) : undefined })),
      );
    },
  }),

  /* ---------------------------------- blocks and library ---------------------------------- */
  tool({
    name: "place_block",
    title: "Place a reusable block",
    area: "Library & blocks",
    description: "Place a reusable block (a circuit saved in the library — search_library kind: block) on a page with its top-left at a cell / point. linked (default): updates of the block replace everything but references; derived: updates keep local properties; independent: plain copy. References are numbered by the project rules.",
    access: "edit",
    input: z.object({ version, page, library_id: z.string(), cell: z.string().optional(), x: z.number().optional(), y: z.number().optional(), mode: z.enum(["linked", "derived", "independent"]).optional() }),
    run: async (x, env) => {
      const b = await libraryBlock(env, x.library_id);
      return editDrawing(env, x.version, "place_block", (d) =>
        guard(() => {
          const pg = getPage(d, findPage(d, x.page).id);
          const at = positionOf(d, pg, { cell: x.cell, x: x.x, y: x.y });
          const tl = { x: at.x - 5, y: at.y - 5 };
          const sel = placeBlock(d, pg, b.id, b.revision, b.name, structuredClone(b.content), tl, x.mode ?? "linked");
          const refs = sel.elements.map((id) => pg.elements.find((e) => e.id === id)?.info.label).filter(Boolean);
          return `Placed block "${b.name}" rev ${b.revision} (${x.mode ?? "linked"}) on page ${sheetNo(d, pg)}: ${plural(sel.elements.length, "component")} (${refs.join(", ") || "no references"}), ${plural(sel.wires.length, "wire")}`;
        }),
      );
    },
  }),
  tool({
    name: "create_block",
    title: "Save components as a reusable block",
    area: "Library & blocks",
    description: "Save components of one page (with the wires and junctions between them) as a reusable block in your personal library (private; publish in Library). Pins wired to anything outside become the block's ports. link = also make these components an instance of the new block (so later block updates can reach them).",
    access: "edit",
    input: z.object({ version, components: z.array(z.string()).min(1).max(500), name: z.string().min(1).max(200), category: z.string().max(200).optional(), description: z.string().max(2000).optional(), link: z.boolean().optional() }),
    run: async (x, env) => {
      assertCanEdit(env, "add to the library");
      assertMember(env.ctx);
      const { doc } = await readVersion(env, x.version);
      const parts = guard(() => partsOf(doc, x.components));
      if (new Set(parts.map((p) => p.page.id)).size > 1) throw new ToolError("A block is made from components of one page");
      const pg = parts[0].page;
      const ids = new Set(parts.map((p) => p.e.id));
      const js = pg.junctions.filter((j) => pg.wires.filter((w) => (w.a.k === "junction" && w.a.j === j.id) || (w.b.k === "junction" && w.b.j === j.id)).every((w) => [w.a, w.b].every((e) => e.k !== "pin" || ids.has(e.el))));
      const sel = mkSel({ elements: [...ids], junctions: js.map((j) => j.id) });
      const built = buildBlock(doc, pg, sel);
      const lib = await writableLibrary(env.ctx, null);
      const el = await createElementRecord({ libraryId: lib.id, ownerId: env.ctx.user.id, kind: "BLOCK", name: x.name, category: normCategory(x.category ?? "Blocks"), description: x.description ?? "", tags: tagsIn(["ai"]), uuid: `block:${newUuid()}`, content: JSON.stringify(built.content), visibility: "PRIVATE", note: `Created via ${via(env)}` });
      await audit({ workspaceId: env.ctx.workspace.id, actorId: env.ctx.user.id, type: "library.create", data: { id: el.id, name: el.name, kind: "BLOCK", visibility: "PRIVATE", status: el.status, via: via(env) } });
      let linked = "";
      if (x.link) {
        linked =
          "\n" +
          (await editDrawing(env, x.version, "create_block", (d) => {
            const p = getPage(d, pg.id);
            const gid = crypto.randomUUID();
            // block content is relative to this origin (recovered from the first element, as the editor does)
            const e0 = built.content.elements[0];
            const o0 = e0 && p.elements.find((q) => q.id === e0.id);
            const origin = o0 ? { x: o0.x - e0.x, y: o0.y - e0.y } : { x: 0, y: 0 };
            const g = (src: string) => ({ id: gid, blockId: el.id, revision: el.revision, mode: "linked" as const, name: x.name, src, origin });
            for (const e of p.elements) if (sel.elements.includes(e.id)) e.group = g(e.id);
            for (const w of p.wires) if (built.content.wires.some((bw) => bw.id === w.id)) w.group = g(w.id);
            for (const j of p.junctions) if (sel.junctions.includes(j.id)) j.group = g(j.id);
            return `Linked ${plural(sel.elements.length, "component")} to the block`;
          }));
      }
      return `Saved block "${x.name}" (${plural(built.content.elements.length, "component")}, ${plural(built.content.wires.length, "wire")}, ports ${built.ports.map((p) => p.name).join(", ") || "none"}) to your personal library — library_id ${el.id}. Place it with place_block.${linked}`;
    },
  }),
  tool({
    name: "manage_block",
    title: "Update, detach or relink a placed block",
    area: "Library & blocks",
    description: "For the block instance a component belongs to: update it to the newest library revision (linked: everything but references is replaced; derived: local properties kept), detach it (independent components), or switch linked ↔ derived.",
    access: "edit",
    input: z.object({ version, component: component.describe("Any component of the placed block"), action: z.enum(["update", "detach", "set_mode"]), mode: z.enum(["linked", "derived"]).optional() }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const { group } = guard(() => groupOf(doc, x.component));
      const b = x.action === "update" ? await libraryBlock(env, group.blockId) : null;
      return editDrawing(env, x.version, "manage_block", (d) =>
        guard(() => {
          const { page, group: g } = groupOf(d, x.component);
          const pg = getPage(d, page.id);
          if (x.action === "detach") {
            detachGroup(pg, g.id);
            return `Detached block instance "${g.name}": its components are independent now`;
          }
          if (x.action === "set_mode") {
            if (!x.mode) throw new ToolError("Give mode: linked or derived");
            for (const it of [...pg.elements, ...pg.wires, ...pg.junctions]) if (it.group?.id === g.id) it.group = { ...it.group, mode: x.mode };
            return `Block instance "${g.name}" is ${x.mode} now`;
          }
          if (b!.revision <= g.revision) return `Block instance "${g.name}" is at rev ${g.revision}, the newest you can use`;
          const r = updateBlockInstance(d, pg, g.id, b!.revision, structuredClone(b!.content));
          return `Updated "${g.name}" rev ${g.revision} → ${b!.revision}: ${r.updated} kept, ${r.added} added, ${r.removed} removed`;
        }),
      );
    },
  }),
  tool({
    name: "update_from_library",
    title: "Update symbols to newer library revisions",
    area: "Library & blocks",
    description: "Find symbols in the drawing whose library element has a newer revision you may use, and (unless dry_run) update every component drawn with them — wires move to the matching pins; ends without a match become free and are reported. Placed blocks: manage_block update.",
    access: "edit",
    input: z.object({ version, dry_run: z.boolean().optional(), only: z.array(z.string()).optional().describe("Only these library_ids") }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const bySource = new Map<string, { rev: number; defs: string[]; count: number }>();
      for (const d of Object.values(doc.defs)) {
        const id = d.source?.libraryElementId;
        if (!id || (x.only && !x.only.includes(id))) continue;
        const cur = bySource.get(id) ?? { rev: 0, defs: [], count: 0 };
        cur.rev = Math.max(cur.rev, d.source?.revision ?? 0);
        cur.defs.push(d.id);
        cur.count += doc.pages.reduce((n, p) => n + p.elements.filter((e) => e.defId === d.id).length, 0);
        bySource.set(id, cur);
      }
      const updates: { id: string; def: Awaited<ReturnType<typeof libraryDef>>; from: number; defs: string[]; count: number }[] = [];
      for (const [id, s] of bySource) {
        if (!s.count) continue;
        const def = await libraryDef(env, id).catch(() => null);
        if (def && (def.source?.revision ?? 0) > s.rev) updates.push({ id, def, from: s.rev, defs: s.defs, count: s.count });
      }
      if (!updates.length) return `All ${bySource.size} library symbols in the drawing are at the newest revision you can use`;
      const list = updates.map((u) => `"${u.def.name}" rev ${u.from} → ${u.def.source?.revision} (${plural(u.count, "component")})`);
      if (x.dry_run) return `Updates available (not applied): ${list.join("; ")}`;
      return editDrawing(env, x.version, "update_from_library", (d) => {
        let loose = 0;
        for (const u of updates) {
          const r = updateInstancesDef(d, new Set(u.defs.filter((k) => k !== u.def.id)), structuredClone(u.def));
          loose += r.loose;
          for (const k of u.defs) if (k !== u.def.id) delete d.defs[k];
        }
        return `Updated ${list.join("; ")}${loose ? `; ${plural(loose, "wire end")} lost their pin (check them)` : ""}`;
      });
    },
  }),
  tool({
    name: "save_symbol_to_library",
    title: "Save a symbol to the library",
    area: "Library & blocks",
    description: "Save the symbol a component is drawn with to your personal library (private draft; publish in Library) — or, with several components, merge their symbols into one new symbol (all their pins), e.g. to turn a hand-drawn connector made of pieces into one component.",
    access: "edit",
    input: z.object({ version, components: z.array(z.string()).min(1).max(100), name: z.string().min(1).max(120).optional(), category: z.string().max(200).optional(), prefix: z.string().max(4).optional() }),
    run: async (x, env) => {
      assertCanEdit(env, "add to the library");
      assertMember(env.ctx);
      const { doc } = await readVersion(env, x.version);
      const parts = guard(() => partsOf(doc, x.components));
      let def;
      if (parts.length === 1) {
        if (!parts[0].def) throw new ToolError("That component has no symbol");
        def = structuredClone(parts[0].def);
        if (x.name) ((def.name = x.name), (def.names = { ...def.names, en: x.name }));
      } else {
        if (new Set(parts.map((p) => p.page.id)).size > 1) throw new ToolError("Merge components of one page");
        def = mergeToDef(doc, parts[0].page, parts.map((p) => p.e.id), x.name ?? `${refOf(doc, parts[0])} merged`);
      }
      if (x.prefix) def.prefix = x.prefix;
      const category = normCategory(x.category ?? (def.category || "Custom"));
      const uuid = newUuid();
      const lib = await writableLibrary(env.ctx, null);
      const el = await createElementRecord({ libraryId: lib.id, ownerId: env.ctx.user.id, name: def.name, category, prefix: def.prefix || guessPrefix({ ...def, category }), description: "", tags: ["ai"], uuid, content: serializeElmt({ ...def, uuid }), meta: Object.fromEntries(Object.entries(def.meta ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>, visibility: "PRIVATE", note: `Saved via ${via(env)}` });
      await audit({ workspaceId: env.ctx.workspace.id, actorId: env.ctx.user.id, type: "library.create", data: { id: el.id, name: def.name, kind: "ELEMENT", visibility: "PRIVATE", status: el.status, via: via(env) } });
      return `Saved "${def.name}" (${plural(def.pins.length, "pin")}) to your personal library — library_id ${el.id}${parts.length > 1 ? `, merged from ${parts.map((p) => refOf(doc, p)).join(", ")}; use replace_symbol or place_component with it` : ""}`;
    },
  }),
];

