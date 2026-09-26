/**
 * Volt seed (idempotent): `npm run db:seed`
 *  - default workspace (WORKSPACE_NAME / WORKSPACE_SLUG)
 *  - admin user (first of ADMIN_EMAILS)
 *  - default APPROVED style template (built-in styles) + default project template
 *  - demo project imported from a real QElectroTech fixture: v1 RELEASED (synthetic approval record), v2 DRAFT
 *  - dev users (only when AUTH_DEV_LOGIN=true): approver, signatory, designer, reviewer
 *  - standard element library (src/lib/library/standard.ts)
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultStyles } from "../src/core/styles";
import { stableStringify } from "../src/core/stable-json";
import { importQet } from "../src/core/qet";
import type { Doc } from "../src/core/model";
import { EMPTY_TEMPLATE } from "../src/lib/templates";

// load .env when run directly (tsx does not)
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {}

const db = new PrismaClient();
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const docHash = (d: Doc) => sha256(stableStringify(d));
const now = () => new Date().toISOString();

const WS_SLUG = process.env.WORKSPACE_SLUG ?? "default";
const WS_NAME = process.env.WORKSPACE_NAME ?? "Workspace";
const ADMIN = (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)[0] ?? "admin@example.com";
const DEV = process.env.AUTH_DEV_LOGIN === "true";
const DEMO_FIXTURE = "2612_ats_singlephase.qet";
const DEMO_NUMBER = "DEMO-001";

function nameFromEmail(e: string) {
  const local = e.split("@")[0];
  return local.split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ") || local;
}

async function user(email: string, name: string, roles: string, workspaceId: string) {
  const u = await db.user.upsert({ where: { email }, update: {}, create: { email, name } });
  await db.membership.upsert({
    where: { workspaceId_userId: { workspaceId, userId: u.id } },
    update: {},
    create: { workspaceId, userId: u.id, roles, source: "MANUAL" },
  });
  return u;
}

/** Same rows as src/lib/versioning.ts reindexVersion (kept local: that module is server-only). */
async function reindex(versionId: string, projectId: string, doc: Doc) {
  const rows: { projectId: string; versionId: string; pageId: string | null; kind: string; refId: string | null; text: string }[] = [];
  for (const p of doc.pages) {
    rows.push({ projectId, versionId, pageId: p.id, kind: "PAGE", refId: p.id, text: p.title });
    for (const e of p.elements) {
      const def = doc.defs[e.defId];
      if (!def || def.name === "volt_junction") continue;
      const label = e.info.label ?? "";
      rows.push({ projectId, versionId, pageId: p.id, kind: "ELEMENT", refId: e.id, text: `${label} ${def.name} ${Object.values(e.info).filter((v) => v && v !== label).join(" ")}`.trim() });
      for (const pin of def.pins) if (pin.name || pin.number) rows.push({ projectId, versionId, pageId: p.id, kind: "PIN", refId: e.id, text: `${label}:${pin.number} ${pin.name}`.trim() });
    }
    for (const w of p.wires) if (w.label) rows.push({ projectId, versionId, pageId: p.id, kind: "WIRE", refId: w.id, text: w.label });
    for (const t of p.texts) if (t.text.trim()) rows.push({ projectId, versionId, pageId: p.id, kind: "LABEL", refId: t.id, text: t.text.slice(0, 200) });
  }
  await db.searchEntry.deleteMany({ where: { versionId } });
  for (let i = 0; i < rows.length; i += 400) await db.searchEntry.createMany({ data: rows.slice(i, i + 400) });
  return rows.length;
}

async function main() {
  // workspace
  let ws = await db.workspace.findUnique({ where: { slug: WS_SLUG } });
  if (!ws) ws = await db.workspace.create({ data: { slug: WS_SLUG, name: WS_NAME, settings: "{}" } });
  console.log(`workspace   ${ws.name} (${ws.slug})`);

  // admin
  const admin = await db.user.upsert({ where: { email: ADMIN }, update: {}, create: { email: ADMIN, name: nameFromEmail(ADMIN) } });
  const am = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: admin.id } } });
  if (!am) await db.membership.create({ data: { workspaceId: ws.id, userId: admin.id, roles: "ADMIN", source: "MANUAL" } });
  else if (!am.roles.split(",").includes("ADMIN")) await db.membership.update({ where: { id: am.id }, data: { roles: `${am.roles},ADMIN` } });
  console.log(`admin       ${admin.email}`);

  // dev users
  const domain = ADMIN.split("@")[1] ?? "example.com";
  let approver = admin;
  if (DEV) {
    approver = await user(`approver@${domain}`, "Asha Approver", "APPROVER", ws.id);
    await user(`signer@${domain}`, "Sam Signatory", "SIGNATORY,VIEWER", ws.id);
    await user(`designer@${domain}`, "Dev Designer", "DESIGNER", ws.id);
    await user(`reviewer@${domain}`, "Riya Reviewer", "REVIEWER", ws.id);
    console.log(`dev users   approver@ signer@ designer@ reviewer@${domain}`);
  }

  // style template
  let style = await db.styleTemplate.findFirst({ where: { workspaceId: ws.id, isDefault: true } });
  if (!style) {
    const styles = defaultStyles();
    style = await db.styleTemplate.create({
      data: {
        workspaceId: ws.id,
        name: "Volt standard",
        styles: JSON.stringify(styles),
        status: "APPROVED",
        isDefault: true,
        ownerId: admin.id,
        history: JSON.stringify([
          { version: 1, action: "create", at: now(), by: admin.name, note: "Seeded from built-in defaults" },
          { version: 1, action: "approve", at: now(), by: admin.name, styles },
          { version: 1, action: "default", at: now(), by: admin.name },
        ]),
      },
    });
  }
  console.log(`style       ${style.name} v${style.version} (${style.status})`);

  // project template
  let tmpl = await db.projectTemplate.findFirst({ where: { workspaceId: ws.id, isDefault: true } });
  if (!tmpl) {
    const content = {
      ...EMPTY_TEMPLATE,
      pages: [{ title: "Cover sheet" }, { title: "Power distribution" }, { title: "Control circuits" }, { title: "Terminal plan" }],
      titleBlockFields: { author: "", date: "%date", indexrev: "", filename: "%filename" },
      styleTemplateId: style.id,
      numbering: [{ id: "rule-all", match: "*", prefix: "", scope: "project" as const, format: "{prefix}{n}", start: 1 }],
      requiredFields: ["customer", "site"],
    };
    tmpl = await db.projectTemplate.create({
      data: {
        workspaceId: ws.id,
        name: "Standard control panel",
        description: "Cover, power, control and terminal pages; requires customer and site.",
        content: JSON.stringify(content),
        status: "APPROVED",
        isDefault: true,
        ownerId: admin.id,
        history: JSON.stringify([
          { version: 1, action: "create", at: now(), by: admin.name },
          { version: 1, action: "approve", at: now(), by: admin.name },
          { version: 1, action: "default", at: now(), by: admin.name },
        ]),
      },
    });
  }
  console.log(`template    ${tmpl.name} v${tmpl.version} (${tmpl.status})`);

  // demo project
  const existing = await db.project.findFirst({ where: { workspaceId: ws.id, number: DEMO_NUMBER } });
  if (existing) {
    console.log(`demo        ${existing.name} already present`);
  } else {
    const file = path.join(process.cwd(), "src/core/qet/__fixtures__/projects", DEMO_FIXTURE);
    const bytes = readFileSync(file);
    const { doc, report } = importQet(bytes.toString("utf8"), DEMO_FIXTURE);
    const name = "Demo — ATS single-phase panel";
    doc.meta.title = name;
    doc.meta.props = { ...doc.meta.props, customer: "Demo customer", site: "Main plant" };
    const folder = (await db.folder.findFirst({ where: { workspaceId: ws.id, name: "Demo projects" } })) ?? (await db.folder.create({ data: { workspaceId: ws.id, name: "Demo projects" } }));
    const t0 = Date.now() - 6 * 86400_000;
    const at = (h: number) => new Date(t0 + h * 3600_000);
    const project = await db.project.create({
      data: {
        workspaceId: ws.id,
        folderId: folder.id,
        number: DEMO_NUMBER,
        name,
        description: `Imported from ${DEMO_FIXTURE} (QElectroTech sample)`,
        tags: JSON.stringify(["demo", "imported", "motor control"]),
        createdById: admin.id,
        createdAt: at(0),
        members: { create: [{ userId: admin.id, roles: "OWNER" }] },
      },
    });
    const h1 = docHash(doc);
    const v1 = await db.version.create({
      data: {
        projectId: project.id,
        seq: 1,
        label: "1",
        status: "RELEASED",
        summary: `Imported from ${DEMO_FIXTURE}`,
        doc: JSON.stringify(doc),
        docHash: h1,
        createdById: admin.id,
        createdAt: at(0),
        submittedAt: at(2),
        approvedAt: at(20),
        releasedAt: at(26),
      },
    });
    await db.importRecord.create({ data: { projectId: project.id, versionId: v1.id, filename: DEMO_FIXTURE, sha256: sha256(bytes), original: bytes, report: JSON.stringify(report), userId: admin.id, createdAt: at(0) } });
    const selfApproved = approver.id === admin.id;
    await db.review.create({
      data: {
        versionId: v1.id,
        submittedById: admin.id,
        instructions: "Seeded demo review — synthetic approval record for the imported drawing.",
        status: "APPROVED",
        createdAt: at(2),
        closedAt: at(20),
        assignments: {
          create: [{ order: 0, userId: approver.id, canApprove: true, decision: "APPROVED", reason: selfApproved ? "Seed: self-approved demo" : "Checked against site survey — OK", decidedById: approver.id, decidedAt: at(20) }],
        },
      },
    });
    const doc2: Doc = structuredClone(doc);
    const v2 = await db.version.create({
      data: { projectId: project.id, seq: 2, label: "2", parentId: v1.id, status: "DRAFT", summary: "Add spare feeder and update motor protection", ticket: "ECR-042", doc: JSON.stringify(doc2), docHash: docHash(doc2), createdById: admin.id, createdAt: at(30) },
    });
    const n1 = await reindex(v1.id, project.id, doc);
    await reindex(v2.id, project.id, doc2);
    const A = (type: string, h: number, data: Record<string, unknown>, versionId: string | null = v1.id, actorId = admin.id) =>
      db.auditEvent.create({ data: { workspaceId: ws!.id, projectId: project.id, versionId, actorId, type, data: JSON.stringify(data), createdAt: at(h) } });
    await A("project.import", 0, { filename: DEMO_FIXTURE, pages: report.pageCount, elements: report.elementCount, wires: report.wireCount, seeded: true });
    await A("version.submit", 2, { label: "1", reviewers: 1 });
    await A("review.approve", 20, { label: "1" }, v1.id, approver.id);
    await A("version.status", 20, { from: "IN_REVIEW", to: "APPROVED", label: "1" });
    await A("version.release", 26, { label: "1", note: "Seeded demo release (no electronic signatures)" });
    await A("version.create", 30, { label: "2", parent: "1", summary: "Add spare feeder and update motor protection" }, v2.id);
    console.log(`demo        ${name}: ${report.pageCount} pages, ${report.elementCount} components, ${n1} search rows; v1 RELEASED, v2 DRAFT`);
  }

  // standard element library (full default collection + starter blocks)
  const { ensureStandardLibrary } = await import("../src/lib/library/standard");
  const r = await ensureStandardLibrary(ws.id, { ownerId: admin.id, log: (m) => process.stdout.write(`\r${m}`) });
  console.log(`\rlibrary     standard collection ${r.version}: +${r.created} elements (${r.skipped} already present), ${r.blocks} blocks in ${(r.ms / 1000).toFixed(1)} s`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
