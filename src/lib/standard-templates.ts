/**
 * Standard style templates (and a starter project template) for every workspace, installed at
 * server start. Runs once per workspace (remembered in the workspace settings), so templates an
 * admin later edits, retires or deletes are left alone.
 *
 * - "IEC 61082 · ISO 3098 (monochrome)": lettering heights from the ISO 3098 series (1.8 / 2.5 /
 *   3.5 / 5 mm), all black for printing and PDF release; default for new projects.
 * - "NFPA 79 · ANSI (North America)": Arial, text no smaller than ~0.1 in (ANSI Y14.2 guidance for
 *   legibility after reduction), black.
 * - "Screen review (color)": Volt's built-in colored defaults (blue wire numbers, violet cables).
 */
import { db } from "@/lib/db";
import { defaultStyles, deepMerge } from "@/core/styles";
import type { DeepPartial, Styles, TextRole, TextStyle } from "@/core/model";
import { EMPTY_TEMPLATE } from "@/lib/templates";

export const STANDARD_TEMPLATES_VERSION = 1;

const MM = 72 / 25.4; // pt per mm

type Preset = { key: string; name: string; styles: Styles; note: string };

function textSet(font: string, sizes: Partial<Record<TextRole, number>>, extra: Partial<Record<TextRole, Partial<TextStyle>>> = {}): DeepPartial<Styles["text"]> {
  const out: Record<string, Partial<TextStyle>> = {};
  for (const [role, size] of Object.entries(sizes)) out[role] = { font, size: Math.round((size as number) * 2) / 2, color: "#000000", background: null, ...(extra[role as TextRole] ?? {}) };
  for (const [role, e] of Object.entries(extra)) if (!out[role]) out[role] = e as Partial<TextStyle>;
  return out as DeepPartial<Styles["text"]>;
}

function presets(): Preset[] {
  const base = defaultStyles();
  const iso = deepMerge(base, {
    text: textSet(
      "ISOCPEUR, Arial, sans-serif",
      {
        componentRef: 3.5 * MM,
        componentName: 2.5 * MM,
        componentRating: 2.5 * MM,
        componentPartNumber: 1.8 * MM,
        componentManufacturer: 1.8 * MM,
        connectorName: 2.5 * MM,
        pinNumber: 1.8 * MM,
        pinName: 1.8 * MM,
        wireLabel: 2.5 * MM,
        wireInfo: 1.8 * MM,
        cableLabel: 2.5 * MM,
        terminalLabel: 2.5 * MM,
        annotation: 2.5 * MM,
        pageTitle: 5 * MM,
        titleBlockField: 2.5 * MM,
        revisionTable: 1.8 * MM,
      },
      { componentRef: { weight: 600 }, pageTitle: { weight: 700 }, pinName: { visible: false }, wireLabel: { background: "#ffffff" }, cableLabel: { italic: false } },
    ),
    graphics: {
      wire: { color: "#000000", width: 1, junctionColor: "#000000" },
      bus: { color: "#000000", width: 2.5 },
      outline: { color: "#000000", widthScale: 1 },
      border: { color: "#000000", headerColor: "#ffffff", font: "ISOCPEUR, Arial, sans-serif" },
      titleBlock: { color: "#000000", font: "ISOCPEUR, Arial, sans-serif" },
      componentInfo: { description: true, rating: true, manufacturer_reference: false, manufacturer: false },
    },
  } as DeepPartial<Styles>);
  const ansi = deepMerge(base, {
    text: textSet(
      "Arial, sans-serif",
      {
        componentRef: 10,
        componentName: 8.5,
        componentRating: 8.5,
        componentPartNumber: 7,
        componentManufacturer: 7,
        connectorName: 8.5,
        pinNumber: 7,
        pinName: 7,
        wireLabel: 8,
        wireInfo: 7,
        cableLabel: 8,
        terminalLabel: 8,
        annotation: 8.5,
        pageTitle: 14,
        titleBlockField: 8,
        revisionTable: 7,
      },
      { componentRef: { weight: 700 }, pageTitle: { weight: 700 }, pinName: { visible: false }, wireLabel: { background: "#ffffff" }, cableLabel: { italic: false } },
    ),
    graphics: {
      wire: { color: "#000000", width: 1, junctionColor: "#000000" },
      bus: { color: "#000000", width: 3 },
      outline: { color: "#000000", widthScale: 1 },
      border: { color: "#000000", headerColor: "#ffffff", font: "Arial, sans-serif" },
      titleBlock: { color: "#000000", font: "Arial, sans-serif" },
      componentInfo: { description: true, rating: true, manufacturer_reference: true, manufacturer: true },
    },
  } as DeepPartial<Styles>);
  return [
    { key: "iec-iso", name: "IEC 61082 · ISO 3098 (monochrome)", styles: iso, note: "ISO 3098 lettering heights 1.8 / 2.5 / 3.5 / 5 mm, black on white for print and PDF release." },
    { key: "nfpa-ansi", name: "NFPA 79 · ANSI (North America)", styles: ansi, note: "Arial, legible after A/B-size reduction, black; manufacturer and part number shown." },
    { key: "screen", name: "Screen review (color)", styles: base, note: "Colored wire numbers and cable labels for on-screen review." },
  ];
}

async function defaultOwner(workspaceId: string): Promise<{ id: string; name: string }> {
  const m = await db.membership.findFirst({ where: { workspaceId, roles: { contains: "ADMIN" } }, orderBy: { createdAt: "asc" }, include: { user: true } });
  return m ? { id: m.userId, name: m.user.name ?? m.user.email ?? "admin" } : { id: "system", name: "Volt" };
}

/** Installs the standard style templates (+ a starter project template) in one workspace, once. */
export async function ensureStandardTemplates(workspaceId: string, log?: (m: string) => void): Promise<number> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return 0;
  const settings = JSON.parse(ws.settings || "{}") as Record<string, unknown>;
  if (Number(settings.standardTemplates ?? 0) >= STANDARD_TEMPLATES_VERSION) return 0;
  const owner = await defaultOwner(workspaceId);
  const at = new Date().toISOString();
  const existing = await db.styleTemplate.findMany({ where: { workspaceId }, select: { id: true, name: true, isDefault: true, status: true } });
  const hasDefault = existing.some((t) => t.isDefault && t.status !== "RETIRED");
  let created = 0;
  let defaultId = existing.find((t) => t.isDefault && t.status !== "RETIRED")?.id;
  for (const p of presets()) {
    if (existing.some((t) => t.name === p.name)) continue;
    const makeDefault = !hasDefault && p.key === "iec-iso";
    const t = await db.styleTemplate.create({
      data: {
        workspaceId,
        name: p.name,
        styles: JSON.stringify(p.styles),
        status: "APPROVED",
        isDefault: makeDefault,
        ownerId: owner.id,
        history: JSON.stringify([
          { version: 1, action: "create", at, by: owner.name, note: `Standard template: ${p.note}` },
          { version: 1, action: "approve", at, by: owner.name, styles: p.styles },
          ...(makeDefault ? [{ version: 1, action: "default", at, by: owner.name }] : []),
        ]),
      },
    });
    if (makeDefault) defaultId = t.id;
    created++;
  }
  // a starter project template when there is none at all
  if (!(await db.projectTemplate.count({ where: { workspaceId } }))) {
    const content = {
      ...EMPTY_TEMPLATE,
      pages: [{ title: "Cover sheet" }, { title: "Power distribution" }, { title: "Control circuits" }, { title: "Terminal plan" }],
      titleBlockFields: { author: "", date: "%date", indexrev: "", filename: "%filename" },
      styleTemplateId: defaultId ?? null,
      numbering: [{ id: "rule-all", match: "*", prefix: "", scope: "project" as const, format: "{prefix}{n}", start: 1 }],
      requiredFields: ["customer", "site"],
    };
    await db.projectTemplate.create({
      data: {
        workspaceId,
        name: "Standard control panel",
        description: "Cover, power, control and terminal pages; requires customer and site.",
        content: JSON.stringify(content),
        status: "APPROVED",
        isDefault: true,
        ownerId: owner.id,
        history: JSON.stringify([
          { version: 1, action: "create", at, by: owner.name, note: "Standard template" },
          { version: 1, action: "approve", at, by: owner.name },
          { version: 1, action: "default", at, by: owner.name },
        ]),
      },
    });
    created++;
  }
  await db.workspace.update({ where: { id: workspaceId }, data: { settings: JSON.stringify({ ...settings, standardTemplates: STANDARD_TEMPLATES_VERSION }) } });
  if (created) log?.(`standard templates for ${ws.name}: ${created} added`);
  return created;
}

export async function ensureStandardTemplatesEverywhere(log?: (m: string) => void) {
  const { ensureDefaultWorkspace } = await import("@/lib/membership");
  await ensureDefaultWorkspace();
  for (const ws of await db.workspace.findMany({ select: { id: true } })) await ensureStandardTemplates(ws.id, log);
}
