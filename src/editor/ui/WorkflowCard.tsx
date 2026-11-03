"use client";
import { useState } from "react";
import type { ReactNode } from "react";
import { Check, X, Clock, RotateCcw, Send, PenLine, MessageSquare, Rocket, Plus, FileDown } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { runFlowAction } from "./flow";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { cn, fmtDate } from "@/lib/utils";
import type { FlowAction, FlowStep, FlowTone } from "@/lib/flow";

export const FLOW_ICON: Record<FlowAction["kind"], ReactNode> = {
  submit: <Send />,
  decide: <PenLine />,
  comments: <MessageSquare />,
  recall: <RotateCcw />,
  release: <Rocket />,
  newVersion: <Plus />,
  releasePdf: <FileDown />,
};

const BAR: Record<FlowTone, string> = { action: "bg-accent", waiting: "bg-warning", done: "bg-success", stopped: "bg-border-strong" };

/** Draft → Approvals → Release: where this version is, what it waits for, what to do next. */
export function WorkflowCard() {
  const flow = useEditor((s) => s.flow);
  const ui = useEditorUI();
  const [recalling, setRecalling] = useState(false);
  if (!flow) return null;
  const recall = flow.actions.find((a) => a.kind === "recall");
  const actions = flow.actions.filter((a) => a.kind !== "recall");
  return (
    <section aria-label="Review and release" className="relative border-b border-border bg-panel-2 p-3">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", BAR[flow.tone])} />
      {flow.steps.length > 0 && <Stepper steps={flow.steps} />}
      <p className={cn("text-xs font-semibold leading-snug", flow.steps.length > 0 && "mt-3")} aria-live="polite">
        {flow.headline}
      </p>
      {flow.approvals && flow.status === "IN_REVIEW" && <Approvals {...flow.approvals} />}
      {flow.waiting.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-subtle">Waiting for</p>
          <ul className="mt-1 space-y-1">
            {flow.waiting.map((w) => (
              <li key={w} className="flex items-start gap-1.5 text-2xs">
                <Clock className="mt-0.5 size-3 shrink-0 text-warning" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {flow.notes.length > 0 && (
        <div className="mt-2 space-y-1">
          {flow.notes.map((n) => (
            <p key={n} className="text-2xs leading-relaxed text-muted">
              {n}
            </p>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {actions.map((a) => (
            <Button key={a.kind} size="xs" variant={a.primary ? "primary" : "secondary"} onClick={() => runFlowAction(a, ui)}>
              {FLOW_ICON[a.kind]} {a.label}
            </Button>
          ))}
        </div>
      )}
      {recall &&
        (recalling ? (
          <RecallForm approved={flow.status === "APPROVED"} onCancel={() => setRecalling(false)} />
        ) : (
          <Button size="xs" variant="ghost" className="mt-1.5 -ml-2" onClick={() => setRecalling(true)} title="The version returns to draft so it can be edited; the review is closed as recalled and has to be done again">
            <RotateCcw /> {recall.label}
          </Button>
        ))}
    </section>
  );
}

function Stepper({ steps }: { steps: FlowStep[] }) {
  const short = (d: string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <ol className="flex items-start" aria-label="Document control steps">
      {steps.map((s, k) => {
        const reached = s.state === "done" || s.state === "current" || s.state === "failed";
        return (
          <li key={s.key} className="relative flex min-w-0 flex-1 flex-col items-center text-center" aria-current={s.state === "current" ? "step" : undefined}>
            {k > 0 && <span aria-hidden className={cn("absolute right-1/2 top-[8px] h-px w-full", reached ? "bg-success" : "bg-border-strong")} />}
            <span
              className={cn(
                "relative z-10 flex size-[17px] items-center justify-center rounded-full",
                s.state === "done" && "bg-success text-white",
                s.state === "current" && "border-2 border-accent bg-panel",
                s.state === "todo" && "border border-border-strong bg-panel",
                s.state === "failed" && "bg-danger text-white",
              )}
            >
              {s.state === "done" && <Check className="size-2.5" strokeWidth={3} />}
              {s.state === "failed" && <X className="size-2.5" strokeWidth={3} />}
              {s.state === "current" && <span className="size-1.5 rounded-full bg-accent" />}
            </span>
            <span className={cn("mt-1 max-w-full truncate px-0.5 text-[10px] font-medium", s.state === "current" ? "text-accent" : s.state === "failed" ? "text-danger" : reached ? "text-fg" : "text-subtle")}>{s.label}</span>
            <span className="text-[9px] text-subtle" title={s.at ? fmtDate(s.at) : undefined}>
              {s.at ? short(s.at) : s.state === "current" ? "now" : "\u00a0"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** n of m approvals: one mark per approval needed, filled for each given (each is a signature) */
function Approvals({ have, need, by }: { have: number; need: number; by: string[] }) {
  return (
    <div className="mt-2 flex items-center gap-2" aria-label={`${have} of ${need} approvals`}>
      <span className="flex gap-1" aria-hidden>
        {Array.from({ length: Math.max(need, have) }, (_, k) => (
          <span key={k} className={cn("flex size-4 items-center justify-center rounded-full", k < have ? "bg-success text-white" : "border border-dashed border-border-strong")}>
            {k < have && <PenLine className="size-2.5" />}
          </span>
        ))}
      </span>
      <span className="min-w-0 truncate text-2xs text-muted">
        {have} of {need} approvals{by.length ? ` · ${by.join(", ")}` : ""}
      </span>
    </div>
  );
}

function RecallForm({ approved, onCancel }: { approved: boolean; onCancel: () => void }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-border bg-panel p-2">
      <p className="text-2xs text-muted">
        {approved
          ? "The version returns to draft and can be edited. The approval is cancelled; approvers are notified and approve again after you resubmit."
          : "The version returns to draft and can be edited. This review is closed and the approvals given so far no longer count; after your changes, submit it again and the approvers sign again."}
      </p>
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. fixing the AI review findings)" rows={2} onKeyDown={(e) => e.stopPropagation()} />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/versions/${v.versionId}/recall`, { method: "POST", json: { reason } });
              ui.toast(`v${v.label} is a draft again`);
              setTimeout(() => location.reload(), 500);
            } catch (e) {
              ui.toast((e as Error).message, { tone: "error" });
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : approved ? "Take back approval" : "Recall to draft"}
        </Button>
      </div>
    </div>
  );
}
