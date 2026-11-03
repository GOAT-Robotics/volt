/**
 * What happens next with a version — the document-control path draft → review → release: where the
 * version is, what it is waiting for, and what the person looking at it can do now.
 *
 * Approvers review and approve in one role; an approval is the approver's electronic signature
 * (typed full name, sealed). With enough approvals (at least two) and no open comments, the version
 * is released at once and its release PDF is digitally signed.
 *
 * Pure (no database): the server gathers a FlowInput (workflow.ts › versionFlow); the editor, the
 * project page and the MCP server show the result, so everyone reads the same next step.
 */

export type FlowStepKey = "draft" | "review" | "release";
/** failed: the version ended at this step (rejected, withdrawn, obsolete) */
export type FlowStepState = "done" | "current" | "todo" | "failed";
export type FlowStep = { key: FlowStepKey; label: string; state: FlowStepState; at: string | null };

export type FlowActionKind = "submit" | "decide" | "comments" | "clearAi" | "recall" | "release" | "newVersion" | "releasePdf";
export type FlowAction = { kind: FlowActionKind; label: string; primary?: boolean };

/** action: the viewer has something to do · waiting: someone else has · done: released · stopped: ended */
export type FlowTone = "action" | "waiting" | "done" | "stopped";

export type Flow = {
  status: string;
  /** empty for imported records */
  steps: FlowStep[];
  /** one sentence: where the version is and what happens next */
  headline: string;
  /** a few words for the editor header */
  short: string;
  /** what the version waits for; each reads after "Waiting for …" */
  waiting: string[];
  /** how to get past the current step */
  notes: string[];
  tone: FlowTone;
  /** what the viewer can do now, the primary one first */
  actions: FlowAction[];
  /** approvals (signatures) of the current review: who approved, how many are needed */
  approvals: { have: number; need: number; by: string[] } | null;
  openComments: number;
  openAiComments: number;
};

export type FlowInput = {
  status: string;
  dates: { submittedAt: string | null; approvedAt: string | null; releasedAt: string | null; endedAt: string | null };
  endReason: string | null;
  policy: { minApprovals: number; requireCommentsResolved: boolean };
  /** what the viewer may do */
  can: {
    /** edit and submit this working version */
    submit: boolean;
    /** release an approved version of the earlier process (new approvals release by themselves) */
    release: boolean;
    /** resolve / won't-fix open threads, AI reviewer findings included */
    closeComments: boolean;
    newVersion: boolean;
    exportPdf: boolean;
    /** take the version back to draft */
    recall: boolean;
  };
  /** the latest review of the version */
  review: {
    status: string;
    /** approvers whose decision is missing ("you" for the viewer) */
    pending: string[];
    /** who approved so far ("you" for the viewer) */
    approvedBy: string[];
    canDecide: boolean;
    canApprove: boolean;
    /** the viewer's decision (PENDING while open), null when not assigned */
    myDecision: string | null;
    /** the decision that sent it back (changes requested / rejected) */
    closedBy: { name: string; decision: string; reason: string | null } | null;
  } | null;
  openComments: number;
  openAiComments: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const isAre = (n: number) => (n === 1 ? "is" : "are");

const STOPPED = ["REJECTED", "WITHDRAWN", "OBSOLETE", "SUPERSEDED"];
const STOP_LABEL: Record<string, string> = { REJECTED: "Rejected", WITHDRAWN: "Withdrawn", OBSOLETE: "Obsolete" };

/** how far the version got: 0 draft, 1 review, 2 release, 3 all done */
function reached(i: FlowInput): number {
  const d = i.dates;
  switch (i.status) {
    case "DRAFT":
    case "CHANGES_REQUESTED":
      return 0;
    case "IN_REVIEW":
    case "REJECTED":
      return 1;
    case "APPROVED":
    case "SIGNED":
      return 2;
    case "RELEASED":
    case "SUPERSEDED":
      return 3;
    default: // WITHDRAWN, OBSOLETE
      return d.releasedAt ? 3 : d.approvedAt ? 2 : 1;
  }
}

function buildSteps(i: FlowInput): FlowStep[] {
  if (i.status === "IMPORTED") return [];
  const d = i.dates;
  const at = reached(i);
  const stopped = STOPPED.includes(i.status) && i.status !== "SUPERSEDED" && at < 3;
  const defs: { key: FlowStepKey; todo: string; done: string; at: string | null }[] = [
    { key: "draft", todo: "Draft", done: "Submitted", at: d.submittedAt },
    { key: "review", todo: "Approvals", done: "Approved", at: d.approvedAt },
    { key: "release", todo: "Release", done: "Released", at: d.releasedAt },
  ];
  return defs.map((s, k) => {
    if (k < at) return { key: s.key, label: s.done, state: "done", at: s.at };
    if (k === at && stopped) return { key: s.key, label: STOP_LABEL[i.status] ?? s.todo, state: "failed", at: d.endedAt };
    return { key: s.key, label: s.todo, state: k === at ? "current" : "todo", at: null };
  });
}

export function computeFlow(i: FlowInput): Flow {
  const st = i.status;
  const open = i.openComments;
  const need = Math.max(2, i.policy.minApprovals);
  const r = i.review;
  const out: Flow = {
    status: st,
    steps: buildSteps(i),
    headline: "",
    short: "",
    waiting: [],
    notes: [],
    tone: "waiting",
    actions: [],
    approvals: r && (st === "IN_REVIEW" || r.status === "APPROVED") ? { have: r.approvedBy.length, need, by: r.approvedBy } : null,
    openComments: open,
    openAiComments: i.openAiComments,
  };
  const act = (a: FlowAction) => void out.actions.push(a);
  const auto = `With ${need} approvals${i.policy.requireCommentsResolved ? " and no open comments" : ""}, Volt releases it and digitally signs the release PDF — no further step.`;

  if (st === "DRAFT" || st === "CHANGES_REQUESTED") {
    const back = r?.closedBy;
    if (st === "CHANGES_REQUESTED") {
      out.headline = `Changes requested${back ? ` by ${back.name}` : ""} — update the drawing and submit it again`;
      out.short = "Changes requested — fix and resubmit";
      if (back?.reason) out.notes.push(`“${back.reason}”`);
    } else {
      out.headline = i.can.submit ? "Draft — submit it for review when the drawing is ready" : "Draft — the drawing is being worked on";
      out.short = "Draft";
    }
    if (open && i.policy.requireCommentsResolved) out.notes.push(`${plural(open, "open comment")} — every comment must be resolved before release, so clearing them before you submit saves a round.`);
    out.notes.push(`After you submit: at least ${need} approvers approve it — each approval is their signature — and Volt then releases it and digitally signs the release PDF.`);
    if (i.can.submit) {
      out.tone = "action";
      act({ kind: "submit", label: st === "CHANGES_REQUESTED" ? "Submit again" : "Submit for review", primary: true });
    }
    return out;
  }

  if (st === "IN_REVIEW") {
    const have = r?.approvedBy.length ?? 0;
    const blockedByComments = i.policy.requireCommentsResolved && open > 0;
    const missing = Math.max(0, need - have);
    if (r?.pending.length) out.waiting.push(`approval from ${names(r.pending)}`);
    if (missing > (r?.pending.length ?? 0)) out.waiting.push(`${plural(missing - (r?.pending.length ?? 0), "more approver")} — every release needs ${need} approvals; recall and resubmit with more approvers`);
    if (blockedByComments) out.waiting.push(`${plural(open, "open comment")} to be resolved${i.openAiComments ? ` (${i.openAiComments === open ? "all" : i.openAiComments} from the AI reviewer)` : ""}`);
    const progress = `${have} of ${need} approvals`;
    if (r?.canDecide) {
      out.tone = "action";
      out.headline = r.canApprove ? `Your approval is needed — it is your signature (${progress} so far)` : "Your review is needed — request changes or reject it (approving needs the Approver role)";
      out.short = "Your approval is needed";
      act({ kind: "decide", label: r.canApprove ? "Approve & sign" : "Review", primary: true });
      if (blockedByComments && r.canApprove) out.notes.push(`Your approval counts right away. The version is released once the ${plural(open, "open comment")} ${isAre(open)} resolved.`);
    } else if (out.waiting.length) {
      out.headline = r?.myDecision === "APPROVED" ? `You approved and signed it (${progress}). It is released once nothing is left below.` : `In review — ${progress}. It is released once nothing is left below.`;
      out.short = r?.pending.length ? `Waiting for approval from ${r.pending[0]}${r.pending.length > 1 ? ` +${r.pending.length - 1}` : ""}` : blockedByComments ? `Waiting for ${plural(open, "open comment")} to be resolved` : `Waiting for ${plural(missing, "more approver")}`;
    } else {
      out.headline = `In review — ${progress}`;
      out.short = "In review";
    }
    if (blockedByComments) {
      out.notes.push("Workspace policy: every comment must be resolved before release — AI reviewer findings included. For each one, fix the drawing (recall to draft, change it, submit again) or close it here with Resolve or Won’t fix.");
      if (i.can.closeComments) {
        if (!r?.canDecide) out.tone = "action";
        act({ kind: "comments", label: `Go through ${plural(open, "open comment")}`, primary: !out.actions.length });
        // AI findings are often many and minor: clear them in one go (closed with a note, kept in the record)
        if (i.openAiComments) act({ kind: "clearAi", label: `Clear ${plural(i.openAiComments, "AI finding")}` });
      }
    }
    out.notes.push(auto);
    if (i.can.recall) act({ kind: "recall", label: "Recall to draft to fix" });
    return out;
  }

  if (st === "APPROVED" || st === "SIGNED") {
    // approved (or signed) under the earlier process, with a separate release step
    out.headline = i.can.release ? `${st === "SIGNED" ? "Signed" : "Approved"} — release it to make it the drawing of record` : `${st === "SIGNED" ? "Signed" : "Approved"} — waiting for a project owner to release it`;
    out.short = i.can.release ? "Next: release" : "Waiting for release";
    if (i.can.release) {
      out.tone = "action";
      act({ kind: "release", label: "Release", primary: true });
    } else out.waiting.push("a project owner to release it");
    out.notes.push("Releasing it digitally signs the release PDF.");
    if (i.can.recall) act({ kind: "recall", label: "Take back approval" });
    return out;
  }

  if (st === "RELEASED") {
    out.tone = "done";
    out.headline = "Released — the digitally signed PDF is ready";
    out.short = "Released · signed PDF ready";
    if (r?.approvedBy.length) out.notes.push(`Approved and signed by ${names(r.approvedBy)}.`);
    out.notes.push("Changes go into a new version; releasing that one supersedes this release.");
    if (i.can.exportPdf) act({ kind: "releasePdf", label: "Download signed PDF", primary: true });
    if (i.can.newVersion) act({ kind: "newVersion", label: "New version" });
    return out;
  }

  if (st === "IMPORTED") {
    out.tone = "done";
    out.headline = "Imported from a .volt file — a read-only record";
    out.short = "Imported record";
    out.notes.push("Comment on it, or start a new version to make changes.");
    if (i.can.newVersion) act({ kind: "newVersion", label: "New version" });
    return out;
  }

  if (STOPPED.includes(st)) {
    out.tone = "stopped";
    const back = r?.closedBy;
    out.headline =
      st === "REJECTED"
        ? `Rejected${back ? ` by ${back.name}` : ""} — start a new version to continue`
        : st === "WITHDRAWN"
          ? "Withdrawn — it must not be used"
          : st === "SUPERSEDED"
            ? "Superseded — a newer release replaces it"
            : "Obsolete — it must not be used";
    out.short = STOP_LABEL[st] ?? "Superseded";
    const why = st === "REJECTED" ? (back?.reason ?? i.endReason) : i.endReason;
    if (why) out.notes.push(`“${why}”`);
    if (i.can.exportPdf && i.dates.releasedAt) act({ kind: "releasePdf", label: "Signed release PDF" });
    if (i.can.newVersion) act({ kind: "newVersion", label: "New version", primary: st === "REJECTED" || st === "WITHDRAWN" });
    return out;
  }

  out.headline = st;
  out.short = st;
  return out;
}

/** The next step as text (MCP server, notifications). */
export function flowText(f: Flow): string {
  return [f.headline, ...(f.waiting.length ? [`Waiting for: ${f.waiting.join("; ")}`] : []), ...f.notes].join("\n");
}
