/**
 * MCP tools for components and wires beyond the basics: mating connectors, arranging and styling
 * components, off-page arrows, replacing symbols, copying circuits, symbol pins, drawing and
 * routing wires, converting drawn lines, and cables.
 */
import "server-only";
import { z } from "zod";
import { arrangeComponents, convertLines, copyComponents, drawWire, folioReports, mateConnectors, replaceSymbols, routeWire, setCable, setSymbolPins, styleComponents, type EndSpec } from "./edits";
import { cablesText } from "./project";
import { colour, component, editDrawing, guard, page, point, readVersion, symbolFor, tool, version, type Tool } from "./kit";
import { findComponents, findPage, positionOf } from "./doc";

const components = z.array(z.string()).min(1).max(500).describe('Component references ("K1", "K1@2", "#1a2b3c4d"); a reference with several parts means all of them');
const end = z
  .object({
    pin: z.string().optional().describe('A pin: "K1:A1", "X1:3:1", "#1a2b3c4d:2"'),
    wire: z.string().optional().describe("An existing wire (#id or its number): connects to it with a T-junction, at the point nearest to `at`/`cell` or to the other end"),
    junction: z.string().optional().describe("A junction id (#…) from list_page_items"),
    at: point.optional().describe("A point (scene units); on a pin, wire end or wire it connects there, else a free end"),
    cell: z.string().optional().describe("Centre of a border cell, e.g. 4C (a free end there)"),
  })
  .describe("One end: pin, wire, junction, or a point (at / cell)");

export const DRAWING_TOOLS: Tool[] = [
  /* ---------------------------------- components ---------------------------------- */
  tool({
    name: "mate_connectors",
    title: "Mate a plug with its socket",
    area: "Components",
    description:
      "Mate two connector halves (plug ↔ socket, or any two parts that connect pin to pin): their pins pair up by pin number (then name, then order), so nets run through the pair and the references cross-link (\"▸ X2\" label). Earlier mates of both are cleared. gender = this component's side (default: from its symbol, else male). mates_with \"\" unmates. Shows the pin pairs and pins without a partner.",
    access: "edit",
    input: z.object({
      version,
      component: component.describe("One connector half (one part: K1@2 if it has several)"),
      mates_with: z.string().describe('The counterpart, e.g. "X2" or "X2@5"; "" = unmate'),
      gender: z.enum(["male", "female"]).optional().describe("This component's side: male = plug / pins, female = socket / receptacle"),
      label: z.enum(["auto", "show", "hide"]).optional().describe('The "▸ counterpart" text: auto = only when the counterpart is on another sheet or far away'),
    }),
    run: async (x, env) => editDrawing(env, x.version, "mate_connectors", (d) => guard(() => mateConnectors(d, x.component, x.mates_with, { gender: x.gender, label: x.label }))),
  }),
  tool({
    name: "arrange_components",
    title: "Rotate, mirror, resize, lock, hide, align",
    area: "Components",
    description: "Arrange components as in the editor's Arrange menu: rotate (each about its own origin, in 90° steps clockwise; −90 = counter-clockwise) or set an absolute rotation, mirror, resize (percent), lock in place / unlock, hide / show, align (left, center, right, top, middle, bottom) or distribute evenly (three or more on one page). Wires stay attached.",
    access: "edit",
    input: z.object({
      version,
      components,
      rotate: z.number().optional().describe("Turn by 90, 180, 270 (or −90) degrees clockwise"),
      rotation: z.number().optional().describe("Absolute rotation: 0, 90, 180, 270"),
      mirrored: z.boolean().optional(),
      scale: z.number().min(20).max(500).optional().describe("Size in percent; 100 = normal"),
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
      align: z.enum(["left", "center", "right", "top", "middle", "bottom"]).optional(),
      distribute: z.enum(["horizontal", "vertical"]).optional(),
    }),
    run: async (x, env) => editDrawing(env, x.version, "arrange_components", (d) => guard(() => arrangeComponents(d, x.components, { rotate: x.rotate, rotation: x.rotation, mirrored: x.mirrored, scale: x.scale, locked: x.locked, hidden: x.hidden, align: x.align, distribute: x.distribute }))),
  }),
  tool({
    name: "style_components",
    title: "How components are drawn",
    area: "Components",
    description: "Display of components: pin numbers / names, which info lines are drawn under the reference (name, rating, part number, manufacturer) and where (auto, right, left, below; alignment), reference text direction, symbol line colour, outline box around the symbol, size / colour / visibility / bold of their texts (\"reference\" or an information name), reset label positions or style overrides. project_default makes the info lines and placement of the first component the default for the whole project.",
    access: "edit",
    input: z.object({
      version,
      components,
      pin_numbers: z.boolean().optional(),
      pin_names: z.boolean().optional(),
      show_info: z.object({ name: z.boolean().optional(), rating: z.boolean().optional(), part_number: z.boolean().optional(), manufacturer: z.boolean().optional() }).optional(),
      info_placement: z.enum(["auto", "right", "left", "below"]).optional(),
      info_align: z.enum(["left", "center", "right"]).optional(),
      reference_direction: z.enum(["component", "horizontal", "vertical"]).optional().describe("component = turns with the component"),
      symbol_colour: colour.optional().describe('Symbol line colour; "" = project style'),
      outline: z.union([z.object({ show: z.boolean().optional(), colour: colour.optional(), dash: z.enum(["solid", "dashed", "dotted", "dashdot"]).optional(), padding: z.number().min(0).max(100).optional() }), z.literal("reset")]).optional().describe("Box around the symbol; reset = project style"),
      texts: z.array(z.object({ text: z.string().describe('"reference", or an information name such as comment, function'), size: z.number().min(2).max(72).optional(), colour: colour.optional(), visible: z.boolean().optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), reset: z.boolean().optional() })).optional(),
      reset_label_positions: z.boolean().optional(),
      reset_overrides: z.boolean().optional(),
      project_default: z.boolean().optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "style_components", (d) =>
        guard(() =>
          styleComponents(d, x.components, {
            pinNumbers: x.pin_numbers,
            pinNames: x.pin_names,
            showInfo: x.show_info,
            infoPlacement: x.info_placement,
            infoAlign: x.info_align,
            referenceDirection: x.reference_direction,
            symbolColour: x.symbol_colour,
            outline: x.outline === undefined ? undefined : x.outline === "reset" ? null : { show: x.outline.show ?? true, ...(x.outline.colour ? { color: x.outline.colour } : {}), ...(x.outline.dash ? { dash: x.outline.dash } : {}), ...(x.outline.padding !== undefined ? { padding: x.outline.padding } : {}) },
            texts: x.texts,
            resetLabelPositions: x.reset_label_positions,
            resetOverrides: x.reset_overrides,
            projectDefault: x.project_default,
          }),
        ),
      ),
  }),
  tool({
    name: "link_offpage_arrows",
    title: "Off-page arrows (folio reports)",
    area: "Components",
    description: "Off-page arrows carry a conductor to another sheet. auto: link every going / coming pair with the same reference. link: link a going arrow to a coming arrow (one going arrow may feed several). unlink: remove links of an arrow (or only to `to`). mark_going / mark_coming: mark an arrow symbol that is not marked yet, so several arrows may share a reference and link across sheets. get_component shows an arrow's links.",
    access: "edit",
    input: z.object({ version, mode: z.enum(["auto", "link", "unlink", "mark_going", "mark_coming"]), arrow: component.optional(), to: component.optional() }),
    run: async (x, env) => editDrawing(env, x.version, "link_offpage_arrows", (d) => guard(() => folioReports(d, x.mode, x.arrow, x.to))),
  }),
  tool({
    name: "replace_symbol",
    title: "Replace a component's symbol",
    area: "Components",
    description: "Draw components with another symbol (e.g. a proper connector symbol instead of a generic box, a 2-pin terminal instead of a 1-pin one) keeping position, reference, data and wires: wires move to the pin with the same number, else the same direction, else the nearest pin; ends without a match become free (reported). The new symbol: library_id from search_library, like = the symbol of another component, or symbol = a symbol name in the drawing.",
    access: "edit",
    input: z.object({ version, components, library_id: z.string().optional(), like: z.string().optional(), symbol: z.string().optional() }),
    run: async (x, env) => {
      const { doc } = await readVersion(env, x.version);
      const def = await symbolFor(env, doc, x);
      return editDrawing(env, x.version, "replace_symbol", (d) => guard(() => replaceSymbols(d, x.components, d.defs[def.id] ?? structuredClone(def))));
    },
  }),
  tool({
    name: "set_symbol_pins",
    title: "Edit a symbol's pins",
    area: "Components",
    description: "Change the pins of the symbol a component is drawn with — in this project, for every component using that symbol: pin number, pin name, and what the pin carries for the electrical check (L, L1–L3, N, PE, DC+, DC0 = 0 V/GND, DC- = negative supply, signal, none = pass-through; \"\" = detect from the name) and its nominal voltage. To change the library itself use create_component revise.",
    access: "edit",
    input: z.object({
      version,
      component: component.describe("Any component drawn with the symbol"),
      pins: z.array(z.object({ pin: z.string().describe("Current pin number, name or p1, p2 …"), number: z.string().max(16).optional(), name: z.string().max(40).optional(), kind: z.string().optional(), volts: z.number().nullable().optional() })).min(1).max(200),
    }),
    run: async (x, env) => editDrawing(env, x.version, "set_symbol_pins", (d) => guard(() => setSymbolPins(d, x.component, x.pins))),
  }),
  tool({
    name: "copy_components",
    title: "Copy components",
    area: "Components",
    description: "Copy components with the wires and junctions between them (a circuit) — on the same page or onto another page — like copy & paste: new references by the numbering rules (renumber false keeps them), device parts copied together share their new reference, a plug and socket copied together stay mated. Place the copy at a cell / point (the first component goes there) or by dx/dy; default +40,+40 on the same page, same position on another page.",
    access: "edit",
    input: z.object({ version, components, to_page: page.optional(), cell: z.string().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), renumber: z.boolean().optional() }),
    run: async (x, env) =>
      editDrawing(env, x.version, "copy_components", (d) =>
        guard(() => {
          const dest = x.to_page !== undefined ? findPage(d, x.to_page) : findComponents(d, x.components[0])[0].page;
          const at = x.cell || (x.x !== undefined && x.y !== undefined) ? positionOf(d, dest, { cell: x.cell, x: x.x, y: x.y }) : undefined;
          return copyComponents(d, x.components, { toPage: x.to_page, at, dx: x.dx, dy: x.dy, renumber: x.renumber });
        }),
      ),
  }),

  /* ---------------------------------- wires ---------------------------------- */
  tool({
    name: "draw_wire",
    title: "Draw a wire",
    area: "Wires & cables",
    description: "Draw a wire between any two ends on one page: pins, a point on an existing wire (makes a T-junction), a junction, or a free point (cell / x,y — a point on a pin, wire end or wire connects there, like snapping in the editor). Routed orthogonally, or through `via` points (elbows are added). Use connect_pins for the simple pin-to-pin case.",
    access: "edit",
    input: z.object({ version, page: page.optional().describe("Needed when neither end is a pin or wire"), from: end, to: end, via: z.array(point).max(50).optional(), number: z.string().max(60).optional() }),
    run: async (x, env) =>
      editDrawing(env, x.version, "draw_wire", (d) =>
        guard(() => drawWire(d, x.from as EndSpec, x.to as EndSpec, { page: x.page, via: x.via, number: x.number }).text),
      ),
  }),
  tool({
    name: "route_wire",
    title: "Re-route or reconnect a wire",
    area: "Wires & cables",
    description: "Change a wire's path: points = the new path (its connected ends stay where they are; elbows are added between points not in line), reroute = automatic orthogonal route between its ends, reconnect = move its start or end to another pin, wire (T-junction), junction or point.",
    access: "edit",
    input: z.object({ version, wire: z.string().describe("Wire id (#…) or number"), points: z.array(point).min(2).max(100).optional(), reroute: z.boolean().optional(), reconnect: z.object({ end: z.enum(["start", "end"]), to: end }).optional() }),
    run: async (x, env) => editDrawing(env, x.version, "route_wire", (d) => guard(() => routeWire(d, x.wire, { points: x.points, reroute: x.reroute, reconnect: x.reconnect }))),
  }),
  tool({
    name: "convert_lines_to_wires",
    title: "Convert drawn lines to wires",
    area: "Wires & cables",
    description: "Turn lines drawn as shapes (e.g. imported or sketched) into real wires: touching ends merge, three or more make a junction, ends near a pin connect to it, ends on another line make a T. Default: every open line on the page; or the line ids from list_page_items.",
    access: "edit",
    input: z.object({ version, page, lines: z.array(z.string()).max(2000).optional() }),
    run: async (x, env) => editDrawing(env, x.version, "convert_lines_to_wires", (d) => guard(() => convertLines(d, x.page, x.lines))),
  }),

  /* ---------------------------------- cables ---------------------------------- */
  tool({
    name: "list_cables",
    title: "Cables",
    area: "Wires & cables",
    description: "Multi-core cables of the project: tag, type, cross-section, shield, length, and which wire uses each core (free cores too).",
    access: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ version }),
    run: async ({ version: v }, env) => {
      const { doc } = await readVersion(env, v);
      return cablesText(doc);
    },
  }),
  tool({
    name: "set_cable",
    title: "Create or change a cable",
    area: "Wires & cables",
    description: "Create a multi-core cable (cores: a count made by scheme colors = IEC 60227 BN/BK/GY/BU, numbered = 1, 2, 3 …, din47100; earth adds a green-yellow core — or an explicit list), change its type (e.g. \"ÖLFLEX CLASSIC 110 4G1,5\"), section, shield, length, note, tag; put wires into it (each gets a free core, PE wires the green-yellow one) or take them out; delete it. Without a tag a new cable gets the next free W number.",
    access: "edit",
    input: z.object({
      version,
      cable: z.string().max(40).optional().describe("Cable tag, e.g. W3 (new if it does not exist)"),
      rename: z.string().max(40).optional(),
      type: z.string().max(200).optional(),
      cores: z.union([z.number().int().min(1).max(200), z.array(z.object({ name: z.string().max(20), colour: z.string().max(20).optional() })).min(1).max(200)]).optional(),
      scheme: z.enum(["colors", "numbered", "din47100"]).optional(),
      earth: z.boolean().optional(),
      section: z.string().max(40).optional(),
      shield: z.boolean().optional(),
      length: z.string().max(40).optional(),
      note: z.string().max(500).optional(),
      add_wires: z.array(z.string()).max(500).optional(),
      remove_wires: z.array(z.string()).max(500).optional(),
      delete: z.boolean().optional(),
    }),
    run: async (x, env) =>
      editDrawing(env, x.version, "set_cable", (d) =>
        guard(() => setCable(d, x.cable, { rename: x.rename, type: x.type, cores: x.cores, scheme: x.scheme, earth: x.earth, section: x.section, shield: x.shield, length: x.length, note: x.note, addWires: x.add_wires, removeWires: x.remove_wires, delete: x.delete })),
      ),
  }),
];
