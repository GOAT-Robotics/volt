/**
 * MCP tools for pages and what is drawn on them besides components and wires: pages (add, copy,
 * order, type, border, title block, archive, delete), cover sheet, texts, shapes, pictures,
 * junctions, and title block templates.
 */
import "server-only";
import { z } from "zod";
import type { TitleBlockLogo } from "@/core/model";
import { base64ToBytes, logoSize } from "@/core/logos";
import { standardTitleBlocks } from "../titleblocks";
import { layoutTemplate, usableLayouts } from "../titleblock-layouts";
import { addPage, addShape, addText, deleteItems, deletePage, editTitleBlock, pageItemsText, setCover, updateItem, updatePage, type TbOp } from "./sheets";
import { colour, editDrawing, guard, page, point, readVersion, tool, ToolError, version, type Env, type Tool } from "./kit";
import type { Doc } from "@/core/model";
import { cellArea, findPage } from "./doc";

const pictureInput = z
  .object({ data: z.string().max(1_200_000).describe("The image file, base64"), type: z.enum(["png", "jpg", "svg"]), name: z.string().max(120).optional() })
  .describe("A picture: base64 PNG, JPEG or SVG, at most 800 KB");

/** checks a picture given by an assistant: type, size, no scripts in SVG */
function picture(p: { data: string; type: "png" | "jpg" | "svg"; name?: string }): TitleBlockLogo & { name?: string } {
  const data = p.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(data);
  } catch {
    throw new ToolError("The picture is not valid base64");
  }
  if (bytes.length > 800 * 1024) throw new ToolError("The picture is larger than 800 KB — make it smaller first");
  const head = Array.from(bytes.slice(0, 4));
  if (p.type === "png" && !(head[0] === 0x89 && head[1] === 0x50)) throw new ToolError("That is not a PNG file");
  if (p.type === "jpg" && !(head[0] === 0xff && head[1] === 0xd8)) throw new ToolError("That is not a JPEG file");
  if (p.type === "svg") {
    const t = new TextDecoder().decode(bytes);
    if (!/<svg[\s>]/i.test(t)) throw new ToolError("That is not an SVG file");
    if (/<script|\son\w+\s*=|javascript:|<foreignObject/i.test(t)) throw new ToolError("SVG pictures may not contain scripts, event handlers or foreignObject");
  }
  const logo: TitleBlockLogo & { name?: string } = { type: p.type, data, ...(p.name ? { name: p.name } : {}) };
  if (!logoSize(logo)) throw new ToolError("Could not read the picture's size");
  return logo;
}

/** a title block template by name: the project's, else a standard or organization one (copied into the project) */
async function templateFor(env: Env, doc: Doc, name: string) {
  if (doc.titleBlocks[name]) return null;
  const std = (await standardTitleBlocks()).find((t) => t.name === name);
  if (std) return std;
  const org = (await usableLayouts(env.ctx.workspace.id)).find((l) => l.name === name || l.id === name);
  const t = org && layoutTemplate(org);
  if (t) return t;
  const stdNames = (await standardTitleBlocks()).map((t) => t.name);
  const orgNames = (await usableLayouts(env.ctx.workspace.id)).map((l) => l.name);
  throw new ToolError(`No title block template "${name}". In the project: ${Object.keys(doc.titleBlocks).join(", ")}; standard: ${stdNames.join(", ") || "none"}; organization: ${orgNames.join(", ") || "none"}`);
}

const position = { cell: z.string().optional().describe("Border cell, e.g. 3C"), x: z.number().optional(), y: z.number().optional() };
const textStyle = {
  role: z.string().optional().describe("Text style role (annotation by default; pageTitle for headings) — see get_settings styles"),
  size: z.number().min(2).max(144).optional().describe("Font size in pt"),
  colour: colour.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  rotation: z.number().optional().describe("Degrees, e.g. 90 for vertical text"),
  font: z.string().max(80).optional(),
  box: z
    .union([
      z.object({
        width: z.number().min(0).max(4000).optional().describe("Wrap width (scene units); 0 = no wrapping"),
        align: z.enum(["left", "center", "right", "justify"]).optional(),
        border: z.object({ colour: z.string(), width: z.number().min(0).max(10) }).nullable().optional(),
        background: z.string().nullable().optional(),
        padding: z.number().min(0).max(100).optional(),
      }),
      z.literal("none"),
    ])
    .optional()
    .describe("Formatted text box (supports **bold**, # headings, - bullet lists); none = plain text"),
};
const boxOf = (b: z.infer<typeof textStyle.box>) => (b === undefined ? undefined : b === "none" ? null : b);

export const SHEET_TOOLS: Tool[] = [
  tool({
    name: "list_page_items",
    title: "Page details: texts, shapes, junctions",
    area: "Pages & annotations",
    description: "A page's setup (border, title block and its fields, cover sheet content, terminal diagram) and what is drawn on it besides components and wires: free texts, shapes, pictures and junctions, with their ids for update_item / delete_items.",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version, page }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      return guard(() => pageItemsText(doc, x.page));
    },
  }),
  tool({
    name: "add_page",
    title: "Add a page",
    area: "Pages & annotations",
    description: "Add a drawing sheet (border and title block like the page before it), a cover sheet (inserted first; project data, manufacturer, revisions), a table of contents (after the cover), terminal diagram sheets for strips (generated from the schematic, as many sheets as needed) — or copy a page (duplicate). after = the page to insert after (default: at the end).",
    access: "edit",
    input: z.object({ version, kind: z.enum(["drawing", "cover", "contents", "terminals"]).optional(), title: z.string().max(200).optional(), after: page.optional(), duplicate: page.optional().describe("Copy this page (components, wires, texts)"), strips: z.array(z.string()).optional().describe("terminals: strips to draw (default: all)") }),
    run: async (x, env) => editDrawing(env, x.version, "add_page", (d) => guard(() => addPage(d, { kind: x.kind, title: x.title, after: x.after, duplicate: x.duplicate, strips: x.strips }).text)),
  }),
  tool({
    name: "update_page",
    title: "Page settings",
    area: "Pages & annotations",
    description: "Rename a page, move it (position 1 = first), change its type (drawing, cover, contents, terminals — a hand-typed cover becomes a real cover sheet), its border grid (columns, rows, cell size, headers), its title block (show, template — standard and organization templates are copied in —, fields such as author, date, indexrev, title; all_pages applies them to every page), which strip and terminals a terminal diagram shows, or archive / restore it.",
    access: "edit",
    input: z.object({
      version,
      page,
      title: z.string().max(200).optional(),
      position: z.number().int().min(1).optional(),
      kind: z.enum(["drawing", "cover", "contents", "terminals"]).optional(),
      border: z.object({ show: z.boolean().optional(), columns: z.number().int().optional(), rows: z.number().int().optional(), column_width: z.number().optional(), row_height: z.number().optional(), show_column_numbers: z.boolean().optional(), show_row_letters: z.boolean().optional() }).optional(),
      title_block: z.object({ show: z.boolean().optional(), template: z.string().optional(), fields: z.record(z.string(), z.string()).optional(), all_pages: z.boolean().optional() }).optional(),
      terminal_diagram: z.object({ strip: z.string().optional(), from: z.number().int().min(1).nullable().optional(), to: z.number().int().min(1).nullable().optional(), style: z.enum(["rail", "box"]).optional() }).optional(),
      archived: z.boolean().optional(),
    }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const tpl = x.title_block?.template ? await templateFor(env, doc, x.title_block.template) : null;
      return editDrawing(env, x.version, "update_page", (d) =>
        guard(() => {
          if (tpl) d.titleBlocks[tpl.name] = structuredClone(tpl);
          return updatePage(d, x.page, {
            title: x.title,
            position: x.position,
            kind: x.kind,
            border: x.border,
            titleBlock: x.title_block ? { show: x.title_block.show, template: tpl ? tpl.name : x.title_block.template, fields: x.title_block.fields, allPages: x.title_block.all_pages } : undefined,
            terminalDiagram: x.terminal_diagram,
            archived: x.archived,
          });
        }),
      );
    },
  }),
  tool({
    name: "delete_page",
    title: "Delete a page",
    area: "Pages & annotations",
    description: "Delete a page and everything on it (archiving with update_page archived: true keeps it out of the set but recoverable). Mates and arrow links to it are removed.",
    access: "edit",
    annotations: { destructiveHint: true },
    input: z.object({ version, page }),
    run: async (x, env) => editDrawing(env, x.version, "delete_page", (d) => guard(() => deletePage(d, x.page))),
  }),
  tool({
    name: "set_cover_sheet",
    title: "Edit the cover sheet",
    area: "Pages & annotations",
    description: "Content of the cover sheet: title and subtitle (may use %projecttitle and project properties), the product data rows (replace all with fields, or set / add / remove single rows with set_fields), manufacturer name and address, notes (formatted), confidentiality notice, revision table on / off, the logo (a picture, none, or organization) and a product picture. The revision rows themselves: update_settings add_revision.",
    access: "edit",
    input: z.object({
      version,
      page: page.optional().describe("Default: the first cover sheet"),
      title: z.string().max(300).optional(),
      subtitle: z.string().max(300).optional(),
      fields: z.array(z.object({ label: z.string().max(100), value: z.string().max(500) })).max(60).optional(),
      set_fields: z.array(z.object({ label: z.string().max(100), value: z.string().max(500), remove: z.boolean().optional() })).max(60).optional(),
      manufacturer: z.string().max(1000).optional(),
      notes: z.string().max(10_000).optional(),
      notice: z.string().max(1000).optional(),
      show_revisions: z.boolean().optional(),
      logo: z.union([pictureInput, z.enum(["none", "organization"])]).optional(),
      product_picture: z.union([pictureInput, z.literal("none")]).optional(),
    }),
    run: async (x, env) => {
      const logo = x.logo === undefined ? undefined : x.logo === "none" ? null : x.logo === "organization" ? "organization" : picture(x.logo);
      const image = x.product_picture === undefined ? undefined : x.product_picture === "none" ? null : picture(x.product_picture);
      return editDrawing(env, x.version, "set_cover_sheet", (d) =>
        guard(() => setCover(d, x.page, { title: x.title, subtitle: x.subtitle, fields: x.fields, setFields: x.set_fields, manufacturer: x.manufacturer, notes: x.notes, notice: x.notice, showRevisions: x.show_revisions, logo: logo as never, image })),
      );
    },
  }),
  tool({
    name: "add_text",
    title: "Add a text",
    area: "Pages & annotations",
    description: "Put a text on a page at a border cell or x/y: notes, headings, warnings, or a formatted box (width, border, background; **bold**, # headings, - bullets). Style by role (annotation, pageTitle …) and size / colour / bold / italic / alignment / rotation.",
    access: "edit",
    input: z.object({ version, page, text: z.string().min(1).max(20_000), ...position, ...textStyle }),
    run: async (x, env) =>
      editDrawing(env, x.version, "add_text", (d) => guard(() => addText(d, x.page, { cell: x.cell, x: x.x, y: x.y }, { text: x.text, role: x.role, size: x.size, colour: x.colour, bold: x.bold, italic: x.italic, align: x.align, rotation: x.rotation, font: x.font, box: boxOf(x.box) }))),
  }),
  tool({
    name: "add_shape",
    title: "Draw a shape or place a picture",
    area: "Pages & annotations",
    description: "Draw on a page: rect / ellipse (two opposite corners), line (two points), polyline / polygon (points) — e.g. a dashed box around a group of devices (an enclosure or a safety function) — with colour, line width, dash and fill; or place a picture (logo, photo) fitted in a rectangle (two corners; its height follows the picture). Points are scene units (render_page tells the cell size).",
    access: "edit",
    input: z.object({
      version,
      page,
      kind: z.enum(["rect", "ellipse", "line", "polyline", "polygon", "picture"]),
      points: z.array(point).min(2).max(500).optional(),
      from_cell: z.string().optional().describe("Instead of points for rect / ellipse / line / picture: the cell of the first corner"),
      to_cell: z.string().optional().describe("…and of the opposite corner"),
      colour: colour.optional(),
      width: z.number().min(0).max(20).optional(),
      dash: z.enum(["solid", "dashed", "dotted", "dashdot"]).optional(),
      fill: z.string().max(40).optional(),
      closed: z.boolean().optional(),
      picture: pictureInput.optional(),
    }),
    run: async (x, env) => {
      const pic = x.picture ? picture(x.picture) : undefined;
      return editDrawing(env, x.version, "add_shape", (d) =>
        guard(() => {
          let pts = x.points;
          if (!pts && x.from_cell && x.to_cell) {
            const pg = findPage(d, x.page);
            // the box covers both cells and everything between them, a little inside their edges
            const a = cellArea(pg, x.from_cell), c = cellArea(pg, x.to_cell);
            const g = d.grid?.size || 10;
            pts = [{ x: Math.min(a.a.x, c.a.x) + g / 2, y: Math.min(a.a.y, c.a.y) + g / 2 }, { x: Math.max(a.b.x, c.b.x) - g / 2, y: Math.max(a.b.y, c.b.y) - g / 2 }];
          }
          if (!pts) throw new ToolError("Give points, or from_cell and to_cell");
          return addShape(d, x.page, x.kind, pts, { colour: x.colour, width: x.width, dash: x.dash, fill: x.fill, closed: x.closed, picture: pic });
        }),
      );
    },
  }),
  tool({
    name: "update_item",
    title: "Change a text, shape or picture",
    area: "Pages & annotations",
    description: "Change a free text (content, style, box) or a drawn shape / picture (colour, width, dash, fill, points, picture) by its id from list_page_items, or move it (to a cell / x,y, or by dx/dy).",
    access: "edit",
    input: z.object({
      version,
      item: z.string().describe("Id (#…) from list_page_items"),
      text: z.string().max(20_000).optional(),
      ...textStyle,
      width: z.number().min(0).max(20).optional().describe("Shapes: line width"),
      dash: z.enum(["solid", "dashed", "dotted", "dashdot"]).optional(),
      fill: z.string().max(40).nullable().optional(),
      closed: z.boolean().optional(),
      points: z.array(point).min(2).max(500).optional(),
      picture: z.union([pictureInput, z.literal("none")]).optional(),
      move_to: z.object(position).optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
    }),
    run: async (x, env) => {
      const pic = x.picture === undefined ? undefined : x.picture === "none" ? null : picture(x.picture);
      return editDrawing(env, x.version, "update_item", (d) =>
        guard(() =>
          updateItem(d, x.item, {
            text: x.text,
            role: x.role,
            size: x.size,
            colour: x.colour,
            bold: x.bold,
            italic: x.italic,
            align: x.align,
            rotation: x.rotation,
            font: x.font,
            box: boxOf(x.box),
            width: x.width,
            dash: x.dash,
            fill: x.fill,
            closed: x.closed,
            points: x.points,
            picture: pic,
            at: x.move_to,
            dx: x.dx,
            dy: x.dy,
          }),
        ),
      );
    },
  }),
  tool({
    name: "delete_items",
    title: "Delete texts, shapes, junctions",
    area: "Pages & annotations",
    description: "Delete free texts, drawn shapes / pictures and junctions by id (list_page_items). Components: delete_component; wires: delete_wires.",
    access: "edit",
    annotations: { destructiveHint: true },
    input: z.object({ version, items: z.array(z.string()).min(1).max(1000) }),
    run: async (x, env) => editDrawing(env, x.version, "delete_items", (d) => guard(() => deleteItems(d, x.items))),
  }),
  tool({
    name: "edit_title_block_template",
    title: "Edit a title block template",
    area: "Pages & annotations",
    description:
      "Edit the grid of a title block template used by the pages (get_settings title_blocks shows it; rows and columns count from 0): set_cell (value such as %title, %author, %folio, %projecttitle or a project property %name; label; show_label; align; size), add_field, remove_cell, span_cell (rowspan/colspan = extra rows/columns), merge_cells, insert_row / delete_row / resize_row, insert_col / delete_col / set_col (width \"50\" units, \"t22\", \"r100\" share of the rest). copy_as saves the result as a new template instead. Organization layouts edited here become project copies.",
    access: "edit",
    input: z.object({
      version,
      template: z.string(),
      operations: z
        .array(
          z.object({
            op: z.enum(["set_cell", "add_field", "remove_cell", "span_cell", "merge_cells", "insert_row", "delete_row", "resize_row", "insert_col", "delete_col", "set_col"]),
            row: z.number().int().min(0).optional(),
            col: z.number().int().min(0).optional(),
            value: z.string().max(500).optional(),
            label: z.string().max(200).optional(),
            name: z.string().max(80).optional(),
            show_label: z.boolean().optional(),
            align: z.enum(["left", "center", "right"]).optional(),
            size: z.number().min(2).max(72).optional(),
            rowspan: z.number().int().min(0).optional(),
            colspan: z.number().int().min(0).optional(),
            cells: z.array(z.object({ row: z.number().int(), col: z.number().int() })).optional(),
            at: z.number().int().min(0).optional(),
            height: z.number().min(5).max(400).optional(),
            width: z.string().optional(),
          }),
        )
        .min(1)
        .max(100),
      copy_as: z.string().max(80).optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "edit_title_block_template", (d) =>
        guard(() => {
          const ops = x.operations.map((o): TbOp => {
            const need = <T,>(v: T | undefined, n: string): T => {
              if (v === undefined) throw new ToolError(`${o.op} needs ${n}`);
              return v;
            };
            switch (o.op) {
              case "set_cell":
                return { op: o.op, row: need(o.row, "row"), col: need(o.col, "col"), value: o.value, label: o.label, show_label: o.show_label, align: o.align, size: o.size, name: o.name };
              case "add_field":
                return { op: o.op, row: need(o.row, "row"), col: need(o.col, "col"), value: o.value, label: o.label, name: o.name, show_label: o.show_label };
              case "remove_cell":
                return { op: o.op, row: need(o.row, "row"), col: need(o.col, "col") };
              case "span_cell":
                return { op: o.op, row: need(o.row, "row"), col: need(o.col, "col"), rowspan: o.rowspan ?? 0, colspan: o.colspan ?? 0 };
              case "merge_cells":
                return { op: o.op, cells: need(o.cells, "cells") };
              case "insert_row":
                return { op: o.op, at: need(o.at, "at"), height: o.height };
              case "delete_row":
                return { op: o.op, at: need(o.at, "at") };
              case "resize_row":
                return { op: o.op, at: need(o.at, "at"), height: need(o.height, "height") };
              case "insert_col":
                return { op: o.op, at: need(o.at, "at"), width: o.width };
              case "delete_col":
                return { op: o.op, at: need(o.at, "at") };
              case "set_col":
                return { op: o.op, at: need(o.at, "at"), width: need(o.width, "width") };
            }
          });
          return editTitleBlock(d, x.template, ops, { copyAs: x.copy_as });
        }),
      ),
  }),
];
