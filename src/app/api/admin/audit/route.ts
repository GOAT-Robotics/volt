import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/access";
import { AUDIT_LABELS } from "@/lib/audit";
import { EXTRA_AUDIT_LABELS } from "@/lib/constants";
import { auditWhere } from "@/lib/auditquery";

export const runtime = "nodejs";

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const sp = new URL(req.url).searchParams;
  const where = auditWhere(ctx.workspace.id, sp);
  const labels = { ...AUDIT_LABELS, ...EXTRA_AUDIT_LABELS };
  if (sp.get("format") === "csv") {
    const rows = await db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: 100_000, include: { actor: { select: { name: true, email: true } } } });
    const pids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
    const projects = new Map((await db.project.findMany({ where: { id: { in: pids } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const lines = ["time,type,event,actor,actor_email,project,project_id,version_id,ip,data"];
    for (const r of rows) lines.push([r.createdAt.toISOString(), r.type, labels[r.type] ?? r.type, r.actor?.name, r.actor?.email, r.projectId ? projects.get(r.projectId) ?? "(deleted)" : "", r.projectId, r.versionId, r.ip, r.data].map(csv).join(","));
    return new Response(lines.join("\n") + "\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="volt-audit-${new Date().toISOString().slice(0, 10)}.csv"`, "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  }
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const size = 50;
  const [total, rows] = await Promise.all([db.auditEvent.count({ where }), db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * size, take: size, include: { actor: { select: { name: true } } } })]);
  return { total, page, pageSize: size, events: rows.map((r) => ({ id: r.id, type: r.type, label: labels[r.type] ?? r.type, actor: r.actor?.name ?? null, projectId: r.projectId, versionId: r.versionId, ip: r.ip, data: JSON.parse(r.data || "{}"), createdAt: r.createdAt.toISOString() })) };
});
