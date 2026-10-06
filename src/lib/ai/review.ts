/**
 * Volt AI Reviewer — the first review of a version.
 *
 *  1. Electrical rule check (src/core/erc.ts) and drawing validation: deterministic findings on
 *     connections, naming, short circuits, wrong wiring, safety and conductor cross-sections.
 *  2. AI engineering review (when OPENAI_API_KEY is set and the workspace allows it): the project
 *     netlist plus the rule-check result go to the model, which reviews it like an experienced
 *     electrical design engineer and returns structured findings with concrete suggestions.
 *
 * Findings are posted as review comments by the "Volt AI Reviewer" system account, anchored on the
 * component or wire they concern; the designer resolves them (open comments block approval when
 * the policy requires resolved comments). Runs in the background; status is kept in memory while
 * running and in the audit trail ("ai.review") afterwards.
 */
import "server-only";
import { db, J } from "../db";
import { audit } from "../audit";
import { notify } from "../notify";
import { parseSettings } from "../settings";
import { editorLink } from "../workflow";
import { parseDoc } from "../versioning";
import { aiEnabled, chatJson } from "./openai";
import { checkElectrical, netlistText, type ErcFinding, type NetlistKeys } from "@/core/erc";
import { validateDoc, type Issue } from "@/core/validate";
import type { Doc } from "@/core/model";

export const BOT_EMAIL = "ai-reviewer@volt.invalid";
export const BOT_NAME = "Volt AI Reviewer";

/** the reviewer's system account (cannot sign in: disabled, reserved .invalid address) */
export async function botUser() {
  return db.user.upsert({ where: { email: BOT_EMAIL }, update: {}, create: { email: BOT_EMAIL, name: BOT_NAME, isBot: true, disabled: true } });
}

const g = globalThis as unknown as { __voltAiRunning?: Map<string, { startedAt: number; by: string | null }> };
const running = (g.__voltAiRunning ??= new Map());
export const aiRunning = (versionId: string) => running.get(versionId) ?? null;

export type AiReviewStatus = {
  running: boolean;
  startedAt: string | null;
  last: { at: string; status: "DONE" | "FAILED"; summary: string; findings: number; errors: number; warnings: number; suggestions: number; model: string | null; error: string | null; truncated: boolean } | null;
};

export async function aiReviewStatus(versionId: string): Promise<AiReviewStatus> {
  const r = running.get(versionId);
  const ev = await db.auditEvent.findFirst({ where: { versionId, type: "ai.review" }, orderBy: { createdAt: "desc" } });
  const d = J.parse<Record<string, unknown>>(ev?.data, {});
  return {
    running: !!r,
    startedAt: r ? new Date(r.startedAt).toISOString() : null,
    last: ev
      ? {
          at: ev.createdAt.toISOString(),
          status: d.status === "FAILED" ? "FAILED" : "DONE",
          summary: String(d.summary ?? ""),
          findings: Number(d.findings ?? 0),
          errors: Number(d.errors ?? 0),
          warnings: Number(d.warnings ?? 0),
          suggestions: Number(d.suggestions ?? 0),
          model: (d.model as string) ?? null,
          error: (d.error as string) ?? null,
          truncated: !!d.truncated,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Model prompt                                                         */
/* ------------------------------------------------------------------ */

const CATEGORIES = ["connection", "naming", "short", "wiring", "safety", "section", "protection", "documentation", "other"] as const;
type Category = (typeof CATEGORIES)[number];
type AiFinding = { severity: "error" | "warning" | "suggestion"; category: Category; title: string; detail: string; suggestion: string; standard: string; page: string; elements: string[]; wires: string[] };
type AiAnswer = { summary: string; findings: AiFinding[] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", description: "3–6 sentences: what the drawing is, overall quality, the most important risks." },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "title", "detail", "suggestion", "standard", "page", "elements", "wires"],
        properties: {
          severity: { type: "string", enum: ["error", "warning", "suggestion"] },
          category: { type: "string", enum: CATEGORIES },
          title: { type: "string", description: "One line, specific (name the reference / wire number)." },
          detail: { type: "string", description: "What is wrong and why, citing the netlist facts that show it." },
          suggestion: { type: "string", description: "Concrete fix: which terminal, which value, which component to add." },
          standard: { type: "string", description: "Clause or standard that applies (e.g. IEC 60204-1 9.4.3), or empty." },
          page: { type: "string", description: "Page key (P3) or empty." },
          elements: { type: "array", items: { type: "string" }, description: "Component keys (E12) concerned, most relevant first." },
          wires: { type: "array", items: { type: "string" }, description: "Wire keys (W7) concerned." },
        },
      },
    },
  },
} as const;

function systemPrompt(houseRules: string, standard: string) {
  return `You are a senior electrical design engineer reviewing an electrical schematic (industrial machinery, robots, control panels) before it is approved for manufacturing. You review it the way a careful checker in a document-control process would, and you write review comments the designer must act on.

You receive the project as a netlist: PAGES, COMPONENTS (key | page | reference | symbol [category] | link type | info such as rating / part number / description | pin numbers:names) and CONDUCTORS (one line per electrical net: the wire segments with number, circuit function, colour and cross-section, and every terminal the net joins as REF:pin@page). Nets are already merged across folio reports, terminals, splices and mated connectors. A FREE-END marks a wire end that is not connected. You also receive the result of the automatic rule check, which has already been posted as separate comments.

Review thoroughly, at least for:
1. Connections — open circuits, coils / loads with only one side connected, missing return paths (0 V, N), missing folio continuations, contacts not linked to their coil, terminals with one side only, devices that cannot work as wired.
2. Naming — reference designations (IEC 81346-2 letter codes, uniqueness, consistency between coil and contacts), wire numbering consistency, terminal numbering (IEC 60445 / IEC 60947: A1-A2 coils, 13-14 NO, 11-12 / 21-22 NC, L1-L2-L3 / T1-T2-T3 power), potential names.
3. Short circuits — different potentials joined directly or through a closed contact path, supply shorted by a contact arrangement, both ends of a coil on the same potential, bridged protective devices.
4. Wrong wiring — reversed polarity, coil voltage vs the potential feeding it (24 V DC coil on 230 V AC), NO used where NC is required and vice versa, missing self-hold / interlock between reversing contactors, wrong phase sequence, neutral switched or fused alone, PE through a switch or fuse, shield / signal wiring mistakes, mixing AC and DC in one circuit.
5. Safety — emergency stop (direct-opening NC contacts, stop category, safety relay with two channels and monitored feedback per ISO 13849-1 / IEC 62061 when present), protective earth of every exposed conductive part, supply-disconnecting device (IEC 60204-1 5.3), overcurrent and short-circuit protection of every circuit including control transformer / power supply secondaries (IEC 60204-1 7.2), motor overload protection, PELV / 0 V bonding, unexpected start-up, interlocks.
6. Wire cross-sections — conductor ampacity against the protective device rating (IEC 60204-1 Table 6 / NFPA 79 Table 12.5.1), minimum sizes, PE size against the phase conductors (IEC 60364-5-54), section changes without protection, missing sections on power conductors, cable cores vs conductors.
7. Protection & ratings — device ratings vs loads, selectivity issues that are evident, breaking capacity concerns when stated, missing ratings / part numbers on safety-relevant devices.
8. Anything else an experienced checker would raise: documentation gaps, unclear notes, inconsistent title data, components that look unused or duplicated, likely drafting mistakes.

Rules:
- Base every finding on facts visible in the netlist; say what you saw (references, pins, wire numbers). When something depends on information that is not in the drawing, say so and phrase it as a check for the designer (severity "suggestion").
- Do not repeat findings that the rule check already reported unless you add a real explanation, root cause or fix.
- severity: "error" = would not work, is unsafe or violates a mandatory requirement; "warning" = likely mistake or non-conformity; "suggestion" = improvement or something to verify.
- Each suggestion must be concrete and actionable (which terminal, which value, which device to add or change).
- Use the keys (E12, W7, P3) exactly as given so comments can be placed on the drawing. Prefer the most specific component.
- Order findings by importance; at most 40. If the drawing looks correct, say so and return few or no findings — do not invent problems.
- The project's wiring standard is ${standard}. Use the conventions of that standard.${houseRules.trim() ? `\n\nThe organisation's own design rules (apply them as requirements):\n${houseRules.trim()}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

type Posted = { level: "error" | "warning" | "suggestion" | "info"; category: string; title: string; detail: string; suggestion: string; standard?: string; source: "rule" | "ai"; pageId: string | null; anchor: { type: "element" | "wire"; id: string; x: number; y: number } | null };

const LEVEL_WORD: Record<Posted["level"], string> = { error: "Error", warning: "Warning", suggestion: "Suggestion", info: "Note" };
const CAT_WORD: Record<string, string> = {
  connection: "Connections",
  naming: "Naming",
  short: "Short circuit",
  wiring: "Wiring",
  safety: "Safety",
  section: "Wire size",
  protection: "Protection",
  documentation: "Documentation",
  other: "General",
  validation: "Drawing check",
};

function commentBody(p: Posted) {
  const head = `${LEVEL_WORD[p.level]} · ${CAT_WORD[p.category] ?? p.category}${p.source === "rule" ? " (rule check)" : ""}`;
  return [`${head}\n${p.title}`, p.detail && p.detail !== p.title ? p.detail : "", p.suggestion ? `Suggestion: ${p.suggestion}` : "", p.standard ? `Reference: ${p.standard}` : ""].filter(Boolean).join("\n\n");
}

function anchorFor(doc: Doc, keys: NetlistKeys, f: { elements: string[]; wires: string[] }) {
  const rev = (m: Map<string, string>) => new Map([...m].map(([id, k]) => [k.toUpperCase(), id]));
  const els = rev(keys.elements), ws = rev(keys.wires);
  for (const k of f.elements) {
    const id = els.get(k.trim().toUpperCase());
    if (!id) continue;
    for (const p of doc.pages) {
      const e = p.elements.find((x) => x.id === id);
      if (e) return { pageId: p.id, anchor: { type: "element" as const, id, x: e.x, y: e.y } };
    }
  }
  for (const k of f.wires) {
    const id = ws.get(k.trim().toUpperCase());
    if (!id) continue;
    for (const p of doc.pages) {
      const w = p.wires.find((x) => x.id === id);
      if (w?.pts.length) {
        const i = Math.floor((w.pts.length - 1) / 2);
        const a = w.pts[i], b = w.pts[Math.min(i + 1, w.pts.length - 1)];
        return { pageId: p.id, anchor: { type: "wire" as const, id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      }
    }
  }
  return null;
}

function fromIssue(doc: Doc, i: Issue): Posted {
  let anchor: Posted["anchor"] = null;
  let pageId = i.pageId ?? null;
  for (const id of i.ids) {
    for (const p of doc.pages) {
      const e = p.elements.find((x) => x.id === id);
      if (e) ((anchor = { type: "element", id, x: e.x, y: e.y }), (pageId = p.id));
      const w = !e ? p.wires.find((x) => x.id === id) : undefined;
      if (w?.pts.length) ((anchor = { type: "wire", id, x: w.pts[0].x, y: w.pts[0].y }), (pageId = p.id));
      if (anchor) break;
    }
    if (anchor) break;
  }
  return { level: i.level, category: "validation", title: i.message, detail: "", suggestion: "", source: "rule", pageId, anchor };
}

function fromErc(f: ErcFinding): Posted {
  return { level: f.level, category: f.category, title: f.message, detail: "", suggestion: f.suggestion, source: "rule", pageId: f.pageId ?? null, anchor: f.anchor ?? null };
}

/** Group repeated rule findings of one kind beyond `max` into one comment. */
function capByCode<T extends { code: string }>(list: T[], max: number): { keep: T[]; extra: Map<string, T[]> } {
  const count = new Map<string, number>();
  const keep: T[] = [];
  const extra = new Map<string, T[]>();
  for (const f of list) {
    const n = (count.get(f.code) ?? 0) + 1;
    count.set(f.code, n);
    if (n <= max) keep.push(f);
    else extra.set(f.code, [...(extra.get(f.code) ?? []), f]);
  }
  return { keep, extra };
}

const LEVEL_RANK = { error: 0, warning: 1, info: 2 } as const;

/**
 * Runs the review for a version. Never throws (failures are recorded). Skips when a run for the
 * version is already in progress.
 */
export async function runAiReview(versionId: string, opts: { trigger: "submit" | "manual"; actorId: string | null }): Promise<void> {
  if (running.has(versionId)) return;
  running.set(versionId, { startedAt: Date.now(), by: opts.actorId });
  let v: (NonNullable<Awaited<ReturnType<typeof db.version.findUnique>>> & { project: { id: string; name: string; workspaceId: string } }) | null = null;
  try {
    v = await db.version.findUnique({ where: { id: versionId }, include: { project: { select: { id: true, name: true, workspaceId: true } } } });
    if (!v) return;
    const project = v.project;
    const ws = await db.workspace.findUnique({ where: { id: project.workspaceId } });
    const settings = parseSettings(ws?.settings);
    const cfg = settings.aiReview;
    const doc = parseDoc(v.doc);
    const bot = await botUser();

    // 1. rules
    const erc = checkElectrical(doc);
    const validation = validateDoc(doc).filter((i) => !["label.overlap", "lib.outdated", "page.duplicate"].includes(i.code));
    const min = LEVEL_RANK[cfg.minLevel];
    const ercPost = capByCode(erc.filter((f) => LEVEL_RANK[f.level] <= min), 8);
    const valPost = capByCode(validation.filter((i) => LEVEL_RANK[i.level] <= min), 6);
    const posts: Posted[] = [...ercPost.keep.map(fromErc), ...valPost.keep.map((i) => fromIssue(doc, i))];
    for (const [, more] of [...ercPost.extra, ...valPost.extra]) {
      const first = more[0] as ErcFinding & Issue;
      const p = "category" in first ? fromErc(first as ErcFinding) : fromIssue(doc, first as Issue);
      posts.push({ ...p, anchor: null, title: `${more.length} more of this kind: ${p.title}`, detail: more.slice(1, 12).map((m) => `• ${(m as { message: string }).message}`).join("\n") });
    }

    // 2. model
    let summary = "";
    let model: string | null = null;
    let truncated = false;
    let aiError: string | null = null;
    const useModel = cfg.useModel && aiEnabled();
    if (useModel) {
      const nl = netlistText(doc);
      truncated = nl.truncated;
      const ruleText = [...erc, ...validation.map((i) => ({ level: i.level, message: i.message }))]
        .slice(0, 150)
        .map((f) => `- [${f.level}] ${f.message}`)
        .join("\n");
      const user = `RULE CHECK RESULT (already posted, ${erc.length + validation.length} findings):\n${ruleText || "- none"}\n\nREVISION: ${project.name} v${v.label} — ${v.summary || "no summary"}${v.description ? `\n${v.description}` : ""}\n\n${nl.text}`;
      try {
        const r = await chatJson<AiAnswer>({ system: systemPrompt(cfg.instructions, (doc.wiring?.standard ?? "iec").toUpperCase()), user, schemaName: "schematic_review", schema: SCHEMA, maxTokens: 16_000 });
        model = r.model;
        summary = r.data.summary?.trim() ?? "";
        for (const f of (r.data.findings ?? []).slice(0, 40)) {
          const at = anchorFor(doc, nl.keys, f);
          const pageFromKey = f.page ? [...nl.keys.pages].find(([, k]) => k.toUpperCase() === f.page.trim().toUpperCase())?.[0] ?? null : null;
          posts.push({
            level: f.severity,
            category: CATEGORIES.includes(f.category) ? f.category : "other",
            title: f.title.trim(),
            detail: f.detail.trim(),
            suggestion: f.suggestion.trim(),
            standard: f.standard.trim(),
            source: "ai",
            pageId: at?.pageId ?? pageFromKey,
            anchor: at?.anchor ?? null,
          });
        }
      } catch (e) {
        aiError = (e as Error).message;
        console.error("[ai-review]", aiError);
      }
    }
    if (!summary) {
      const e = erc.filter((f) => f.level === "error").length, w = erc.filter((f) => f.level === "warning").length, i = erc.filter((f) => f.level === "info").length;
      summary = `Rule check: ${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}, ${i} note${i === 1 ? "" : "s"}${validation.length ? `; drawing check: ${validation.length} item${validation.length === 1 ? "" : "s"}` : ""}.${useModel ? (aiError ? ` The AI review could not run: ${aiError}` : "") : " AI engineering review is off — rule checks only."}`;
    }
    const notesOnly = erc.filter((f) => LEVEL_RANK[f.level] > min);
    if (notesOnly.length) summary += `\n\nNot posted as comments (${cfg.minLevel === "error" ? "warnings and notes" : "notes"}): ${notesOnly.slice(0, 8).map((f) => f.message).join("; ")}${notesOnly.length > 8 ? ` … and ${notesOnly.length - 8} more` : ""}.`;

    // 3. post: earlier open bot threads are superseded by this run
    const firstPage = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order).find((p) => p.kind !== "cover" && p.kind !== "contents") ?? doc.pages[0];
    const now = new Date();
    const old = await db.comment.findMany({ where: { versionId, authorId: bot.id, parentId: null, status: { in: ["OPEN", "REOPENED"] } }, select: { id: true, pageId: true } });
    const ops = [
      ...old.map((c) => db.comment.update({ where: { id: c.id }, data: { status: "RESOLVED" } })),
      ...old.map((c) => db.comment.create({ data: { projectId: project.id, versionId, pageId: c.pageId, parentId: c.id, body: `Superseded by the AI review of ${now.toISOString().slice(0, 16).replace("T", " ")} UTC — open findings were posted again if they still apply.`, authorId: bot.id } })),
      ...posts.map((p) =>
        db.comment.create({ data: { projectId: project.id, versionId, pageId: p.pageId ?? firstPage?.id ?? null, anchor: p.anchor ? JSON.stringify(p.anchor) : null, body: commentBody(p).slice(0, 10_000), authorId: bot.id } }),
      ),
    ];
    for (let i = 0; i < ops.length; i += 200) await db.$transaction(ops.slice(i, i + 200));

    const count = (l: Posted["level"]) => posts.filter((p) => p.level === l).length;
    const data = { status: "DONE", trigger: opts.trigger, summary, findings: posts.length, errors: count("error"), warnings: count("warning"), suggestions: count("suggestion") + count("info"), model, truncated, aiError, label: v.label };
    await audit({ workspaceId: project.workspaceId, projectId: project.id, versionId, actorId: opts.actorId, type: "ai.review", data });
    const to = [...new Set([v.createdById, ...(opts.actorId ? [opts.actorId] : [])])];
    await notify(to, {
      type: "ai.review",
      title: `AI review of ${project.name} v${v.label}: ${posts.length ? `${data.errors} error${data.errors === 1 ? "" : "s"}, ${data.warnings} warning${data.warnings === 1 ? "" : "s"}, ${data.suggestions} suggestion${data.suggestions === 1 ? "" : "s"}` : "no findings"}`,
      body: summary.slice(0, 400),
      link: editorLink(project.id, versionId, "?panel=review"),
      workspaceId: project.workspaceId,
    });
  } catch (e) {
    console.error("[ai-review] failed", e);
    if (v?.project) await audit({ workspaceId: v.project.workspaceId, projectId: v.project.id, versionId, actorId: opts.actorId, type: "ai.review", data: { status: "FAILED", error: (e as Error).message.slice(0, 300), label: v.label } }).catch(() => {});
  } finally {
    running.delete(versionId);
  }
}
