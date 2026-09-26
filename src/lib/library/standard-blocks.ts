/**
 * Starter circuit blocks built from standard-library elements (so every block links back to the
 * library and cross references like KM1 coil ↔ KM1 contacts work out of the box).
 */
import { db } from "@/lib/db";
import { parseElmt } from "@/core/qet/elmt";
import { newDoc } from "@/core/doc";
import { addWire, emptySel, newElement, type EndTarget } from "@/core/ops";
import { buildBlock } from "@/core/blocks";
import { orthoRoute } from "@/core/wires";
import { rotOrient, snapGrid, toScene } from "@/core/geometry";
import type { Doc, ElemInst, ElementDef, Orient, Page, Pt } from "@/core/model";

const E = "10_electric/10_allpole";
const P = {
  mpcb3: `${E}/200_fuses_protective_gears/12_magneto_thermal_circuit_breakers/fa4202_disjoncteur_moteur_3p.elmt`,
  mcb1pn: `${E}/200_fuses_protective_gears/12_magneto_thermal_circuit_breakers/dis_mag_term_2f-1.elmt`,
  km3: `${E}/310_relays_contactors_contacts/02_contacts_cross_referencing/02_power_contacts/com_puiss4.elmt`,
  ol3: `${E}/200_fuses_protective_gears/30_thermal_relays/relais_therm4.elmt`,
  olNC: `${E}/310_relays_contactors_contacts/02_contacts_cross_referencing/15_protection_contacts/act_thermique_nf_esclave.elmt`,
  motor3: `${E}/391_consumers_actuators/10_engines/moteur_tri_1.elmt`,
  pbNO: `${E}/380_signaling_operating/20_push_buttons/poussoir.elmt`,
  pbNC: `${E}/380_signaling_operating/20_push_buttons/poussoir_nf.elmt`,
  estop: `${E}/380_signaling_operating/20_push_buttons/au.elmt`,
  coil: `${E}/310_relays_contactors_contacts/01_coils/bobine3.elmt`,
  aux: `${E}/310_relays_contactors_contacts/02_contacts_cross_referencing/01_auxiliary_contacts/con_simple.elmt`,
  lamp: `${E}/380_signaling_operating/11_optical_signaling/lampe2.elmt`,
  fuse: `10_electric/11_singlepole/200_fuses_protective_gears/10_fuses/fusible.elmt`,
  psu: `${E}/330_transformers_power_supplies/30_power_supplies/power_supply_1_phase_ac_dc.elmt`,
  term5: `${E}/130_terminals_terminal_strips/bornier5x.elmt`,
};

type Ctx = { doc: Doc; page: Page; defs: Map<string, ElementDef> };

function place(c: Ctx, key: keyof typeof P, col: number, y: number, label: string): ElemInst {
  const def = c.defs.get(P[key]);
  if (!def) throw new Error(`standard element missing: ${P[key]}`);
  // align the first north pin (or the hotspot) with the column
  const firstN = [...def.pins].filter((p) => p.orient === "n").sort((a, b) => a.x - b.x)[0];
  const x = snapGrid(col - (firstN?.x ?? 0), 10);
  const e = newElement(c.doc, c.page, def, { x, y: snapGrid(y, 10) });
  e.info.label = label;
  return e;
}

const pinsOf = (c: Ctx, e: ElemInst, o: Orient) => {
  const def = c.doc.defs[e.defId];
  return def.pins
    .filter((p) => rotOrient(p.orient, e.rot, e.mirror) === o)
    .map((p) => ({ pin: p, p: toScene(e, p) }))
    .sort((a, b) => a.p.x - b.p.x);
};

function wire(c: Ctx, a: ElemInst, ai: { o: Orient; i: number }, b: ElemInst, bi: { o: Orient; i: number }) {
  const A = pinsOf(c, a, ai.o)[ai.i], B = pinsOf(c, b, bi.o)[bi.i];
  if (!A || !B) throw new Error("pin not found");
  const from: EndTarget = { k: "pin", el: a.id, pin: A.pin.id, p: A.p };
  const to: EndTarget = { k: "pin", el: b.id, pin: B.pin.id, p: B.p };
  addWire(c.page, from, to, orthoRoute(A.p, B.p, ai.o, bi.o));
}

/** Connect every south pin of a to the north pin of b in left-to-right order. */
function chain(c: Ctx, a: ElemInst, b: ElemInst, n?: number) {
  const s = pinsOf(c, a, "s"), N = pinsOf(c, b, "n");
  const k = Math.min(n ?? Infinity, s.length, N.length);
  for (let i = 0; i < k; i++) wire(c, a, { o: "s", i }, b, { o: "n", i });
}

type Spec = { key: string; name: string; category: string; description: string; tags: string[]; build: (c: Ctx) => void };

const dolPower = (c: Ctx, col: number) => {
  const q = place(c, "mpcb3", col, 105, "Q1");
  const km = place(c, "km3", col, 235, "KM1");
  const ol = place(c, "ol3", col, 345, "F2");
  const m = place(c, "motor3", col, 465, "M1");
  chain(c, q, km);
  chain(c, km, ol);
  // motor terminals U1 V1 W1 are ordered left→right as U1, V1, W1
  chain(c, ol, m);
};

const startStop = (c: Ctx, col: number) => {
  const f = place(c, "fuse", col, 95, "F3");
  const s0 = place(c, "estop", col, 195, "S0");
  const ol = place(c, "olNC", col, 295, "F2");
  const s1 = place(c, "pbNC", col, 395, "S1");
  const s2 = place(c, "pbNO", col, 495, "S2");
  const hold = place(c, "aux", col + 60, 495, "KM1");
  const k = place(c, "coil", col, 605, "KM1");
  chain(c, f, s0);
  chain(c, s0, ol);
  chain(c, ol, s1);
  chain(c, s1, s2);
  chain(c, s2, k);
  wire(c, s1, { o: "s", i: 0 }, hold, { o: "n", i: 0 });
  wire(c, hold, { o: "s", i: 0 }, k, { o: "n", i: 0 });
};

const SPECS: Spec[] = [
  {
    key: "dol-power",
    name: "DOL starter — power circuit",
    category: "Blocks/Motor control",
    description: "Motor circuit breaker, contactor main contacts, overload relay and 3-phase motor.",
    tags: ["motor", "starter", "3-phase"],
    build: (c) => dolPower(c, 105),
  },
  {
    key: "start-stop",
    name: "Start/stop control with self-holding",
    category: "Blocks/Motor control",
    description: "Control fuse, emergency stop, overload NC contact, stop and start push-buttons with KM1 holding contact and KM1 coil.",
    tags: ["control", "self-holding", "start", "stop"],
    build: (c) => startStop(c, 105),
  },
  {
    key: "dol-complete",
    name: "DOL motor starter (power + control)",
    category: "Blocks/Motor control",
    description: "Direct-on-line starter: power circuit and self-holding control circuit; KM1 and F2 are cross-referenced.",
    tags: ["motor", "starter", "3-phase", "control"],
    build: (c) => {
      dolPower(c, 105);
      startStop(c, 355);
    },
  },
  {
    key: "pilot-lamp",
    name: "Pilot lamp on contact",
    category: "Blocks/Signalling",
    description: "KM1 auxiliary NO contact switching indicator lamp H1.",
    tags: ["lamp", "indicator", "signalling"],
    build: (c) => {
      const k = place(c, "aux", 105, 105, "KM1");
      const h = place(c, "lamp", 105, 215, "H1");
      chain(c, k, h);
    },
  },
  {
    key: "relay-contact",
    name: "Relay coil with NO contact",
    category: "Blocks/Relays",
    description: "Relay coil K1 and its NO contact — the contact follows the coil's reference.",
    tags: ["relay", "coil", "contact"],
    build: (c) => {
      place(c, "coil", 105, 105, "K1");
      place(c, "aux", 205, 105, "K1");
    },
  },
  {
    key: "psu-24v",
    name: "24 V DC power supply with MCB",
    category: "Blocks/Power supply",
    description: "1P+N miniature circuit breaker feeding a single-phase 24 V DC power supply.",
    tags: ["power supply", "24V", "psu"],
    build: (c) => {
      const q = place(c, "mcb1pn", 105, 105, "Q2");
      const g = place(c, "psu", 115, 245, "G1");
      chain(c, q, g, 2);
    },
  },
  {
    key: "terminal-3pnpe",
    name: "Terminal strip L1 L2 L3 N PE",
    category: "Blocks/Terminals",
    description: "Five-way terminal block for a 3-phase + neutral + earth supply.",
    tags: ["terminal", "supply"],
    build: (c) => {
      place(c, "term5", 105, 105, "X1");
    },
  },
];

/** Creates any missing standard blocks in the standard library. Returns the number created. */
export async function installStandardBlocks(libraryId: string, ownerId: string): Promise<number> {
  const existing = new Set((await db.libraryElement.findMany({ where: { libraryId, kind: "BLOCK" }, select: { uuid: true } })).map((b) => b.uuid));
  const todo = SPECS.filter((s) => !existing.has(`std-block:${s.key}`));
  if (!todo.length) return 0;
  const rows = await db.libraryElement.findMany({ where: { libraryId, kind: "ELEMENT", source: { in: Object.values(P).map((p) => `volt:standard/${p}`) } }, select: { id: true, revision: true, content: true, source: true, status: true } });
  const defs = new Map<string, ElementDef>();
  for (const r of rows) {
    const path = r.source!.slice("volt:standard/".length);
    const id = `lib:${r.id}@${r.revision}`;
    const def = parseElmt(r.content, { id });
    def.id = id;
    def.source = { libraryElementId: r.id, revision: r.revision, status: r.status };
    defs.set(path, def);
  }
  let created = 0;
  for (const s of todo) {
    const doc = newDoc(s.name);
    doc.numbering.autoOnPlace = false;
    const c: Ctx = { doc, page: doc.pages[0], defs };
    try {
      s.build(c);
    } catch (e) {
      console.error(`[standard-blocks] ${s.key}:`, (e as Error).message);
      continue;
    }
    const sel = { ...emptySel(), elements: c.page.elements.map((e) => e.id), wires: c.page.wires.map((w) => w.id), junctions: c.page.junctions.map((j) => j.id) };
    const { content } = buildBlock(doc, c.page, sel);
    await db.libraryElement.create({
      data: {
        libraryId,
        ownerId,
        kind: "BLOCK",
        name: s.name,
        category: s.category,
        prefix: "",
        description: s.description,
        tags: JSON.stringify(s.tags),
        uuid: `std-block:${s.key}`,
        content: JSON.stringify(content),
        meta: JSON.stringify({ __approvedRev: 1 }),
        visibility: "ORG",
        status: "APPROVED",
        revision: 1,
        source: `volt:standard/blocks/${s.key}`,
        approvedById: ownerId,
        approvedAt: new Date(),
      },
    });
    created++;
  }
  return created;
}

export type { Pt };
