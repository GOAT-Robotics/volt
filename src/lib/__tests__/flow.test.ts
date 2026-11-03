import { describe, expect, it } from "vitest";
import { computeFlow, type FlowInput } from "../flow";

const can0: FlowInput["can"] = { submit: false, release: false, closeComments: false, newVersion: false, exportPdf: false, recall: false };
const base = (over: Partial<FlowInput> = {}): FlowInput => ({
  status: "DRAFT",
  dates: { submittedAt: null, approvedAt: null, releasedAt: null, endedAt: null },
  endReason: null,
  policy: { minApprovals: 2, requireCommentsResolved: true },
  can: can0,
  review: null,
  openComments: 0,
  openAiComments: 0,
  ...over,
});
const review = (over: Partial<NonNullable<FlowInput["review"]>> = {}): NonNullable<FlowInput["review"]> => ({
  status: "OPEN",
  pending: [],
  approvedBy: [],
  canDecide: false,
  canApprove: false,
  myDecision: null,
  closedBy: null,
  ...over,
});
const states = (f: ReturnType<typeof computeFlow>) => f.steps.map((s) => `${s.key}:${s.state}`).join(" ");

describe("computeFlow — draft → approvals → release", () => {
  it("a draft the viewer can edit asks to submit and explains what follows", () => {
    const f = computeFlow(base({ can: { ...can0, submit: true } }));
    expect(f.tone).toBe("action");
    expect(f.actions[0]).toMatchObject({ kind: "submit", primary: true });
    expect(f.notes.join(" ")).toContain("at least 2 approvers");
    expect(states(f)).toBe("draft:current review:todo release:todo");
  });

  it("never asks for fewer than 2 approvals", () => {
    const f = computeFlow(base({ status: "IN_REVIEW", policy: { minApprovals: 1, requireCommentsResolved: false }, review: review({ approvedBy: ["Asha"], pending: ["Riya"] }) }));
    expect(f.approvals).toEqual({ have: 1, need: 2, by: ["Asha"] });
  });

  it("you approved, the other approver and open AI findings are still missing", () => {
    const f = computeFlow(
      base({
        status: "IN_REVIEW",
        dates: { ...base().dates, submittedAt: "2026-11-01T00:00:00Z" },
        review: review({ myDecision: "APPROVED", approvedBy: ["you"], pending: ["Asha"] }),
        openComments: 37,
        openAiComments: 37,
        can: { ...can0, closeComments: true, recall: true },
      }),
    );
    expect(f.headline).toBe("You approved and signed it (1 of 2 approvals). It is released once nothing is left below.");
    expect(f.waiting).toEqual(["approval from Asha", "37 open comments to be resolved (all from the AI reviewer)"]);
    expect(f.short).toBe("Waiting for approval from Asha");
    expect(f.actions.map((a) => a.kind)).toEqual(["comments", "clearAi", "recall"]);
    expect(f.actions[1].label).toBe("Clear 37 AI findings");
    expect(f.notes.join(" ")).toContain("Volt releases it and digitally signs the release PDF");
    expect(states(f)).toBe("draft:done review:current release:todo");
  });

  it("a review with too few approvers says so", () => {
    const f = computeFlow(base({ status: "IN_REVIEW", review: review({ approvedBy: ["Asha"], pending: [] }) }));
    expect(f.waiting[0]).toMatch(/^1 more approver — every release needs 2 approvals/);
  });

  it("an assigned approver is asked to approve and sign", () => {
    const f = computeFlow(base({ status: "IN_REVIEW", review: review({ pending: ["you", "Asha"], canDecide: true, canApprove: true, myDecision: "PENDING" }) }));
    expect(f.short).toBe("Your approval is needed");
    expect(f.headline).toBe("Your approval is needed — it is your signature (0 of 2 approvals so far)");
    expect(f.waiting).toEqual(["approval from you and Asha"]);
    expect(f.actions[0]).toMatchObject({ kind: "decide", label: "Approve & sign", primary: true });
  });

  it("released: download the signed PDF", () => {
    const f = computeFlow(base({ status: "RELEASED", dates: { submittedAt: "a", approvedAt: "b", releasedAt: "c", endedAt: null }, review: review({ status: "APPROVED", approvedBy: ["Asha", "Riya"] }), can: { ...can0, exportPdf: true, newVersion: true } }));
    expect(f.tone).toBe("done");
    expect(f.actions[0]).toMatchObject({ kind: "releasePdf", label: "Download signed PDF", primary: true });
    expect(f.notes[0]).toBe("Approved and signed by Asha and Riya.");
    expect(states(f)).toBe("draft:done review:done release:done");
  });

  it("approved under the earlier process: an owner releases it", () => {
    expect(computeFlow(base({ status: "APPROVED", can: { ...can0, release: true } })).actions[0]).toMatchObject({ kind: "release", primary: true });
    const other = computeFlow(base({ status: "SIGNED" }));
    expect(other.waiting).toEqual(["a project owner to release it"]);
    expect(states(other)).toBe("draft:done review:done release:current");
  });

  it("rejected stops at review; changes requested quotes the reviewer", () => {
    const rej = computeFlow(base({ status: "REJECTED", review: review({ status: "REJECTED", closedBy: { name: "Asha", decision: "REJECTED", reason: "wrong project" } }), can: { ...can0, newVersion: true } }));
    expect(rej.headline).toBe("Rejected by Asha — start a new version to continue");
    expect(rej.notes).toEqual(["“wrong project”"]);
    expect(states(rej)).toBe("draft:done review:failed release:todo");
    const cr = computeFlow(base({ status: "CHANGES_REQUESTED", review: review({ status: "CHANGES_REQUESTED", closedBy: { name: "Riya", decision: "CHANGES_REQUESTED", reason: "Add PE to X4" } }), can: { ...can0, submit: true } }));
    expect(cr.headline).toBe("Changes requested by Riya — update the drawing and submit it again");
    expect(cr.notes[0]).toBe("“Add PE to X4”");
    expect(cr.actions[0].label).toBe("Submit again");
  });

  it("a superseded release still offers its signed PDF", () => {
    const f = computeFlow(base({ status: "SUPERSEDED", dates: { submittedAt: "a", approvedAt: "b", releasedAt: "c", endedAt: "d" }, endReason: "Superseded by v3", can: { ...can0, exportPdf: true } }));
    expect(f.actions[0].kind).toBe("releasePdf");
    expect(states(f)).toBe("draft:done review:done release:done");
  });
});
