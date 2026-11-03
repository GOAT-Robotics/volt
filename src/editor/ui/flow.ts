"use client";
import { useEffect } from "react";
import { useEditor } from "../store";
import { api } from "@/lib/fetcher";
import type { Flow, FlowAction } from "@/lib/flow";
import type { EditorUI } from "./context";

const WORKING = ["DRAFT", "CHANGES_REQUESTED"];
let latest = 0;
/** versions whose Review panel was opened automatically (once per page load) */
const opened = new Set<string>();

/**
 * Loads the version's next step into the store (and follows status changes made by others).
 * Every call fetches (after an approval the answer must be fresh); only the newest answer is used.
 */
export async function refreshFlow(): Promise<Flow | null> {
  const v = useEditor.getState().version;
  if (!v) return null;
  const mine = ++latest;
  let flow: Flow;
  try {
    flow = (await api<{ flow: Flow }>(`/api/versions/${v.versionId}/flow`)).flow;
  } catch {
    return null;
  }
  const s = useEditor.getState();
  if (mine !== latest) return s.flow;
  if (!s.version || s.version.versionId !== v.versionId) return null;
  s.set("flow", flow);
  if (!opened.has(v.versionId)) {
    opened.add(v.versionId);
    if (flow.tone === "action" && !WORKING.includes(flow.status) && s.panels.right !== "process" && s.panels.right !== "review") s.set("panels", { ...s.panels, right: "process" });
  }
  const was = s.version.status;
  // frozen → frozen (in review → released …): just show the new status; frozen → working
  // (changes requested, recalled): reload so editing comes back. Working → frozen is handled by
  // the submit dialog and the live session, which also take care of unsaved changes.
  if (was !== flow.status && !WORKING.includes(was)) {
    if (WORKING.includes(flow.status)) location.reload();
    else s.set("version", { ...s.version, status: flow.status });
  }
  return flow;
}

/** Keeps the next step current: on open, on focus, and every 30 s while the version is frozen. */
export function useFlowSync() {
  const id = useEditor((s) => s.version?.versionId);
  const status = useEditor((s) => s.version?.status);
  useEffect(() => {
    if (!id) return;
    void refreshFlow();
    const onFocus = () => void refreshFlow();
    window.addEventListener("focus", onFocus);
    const t = status && !WORKING.includes(status) ? setInterval(() => document.visibilityState === "visible" && void refreshFlow(), 30000) : null;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (t) clearInterval(t);
    };
  }, [id, status]);
}

/** Opens the Review panel (decision box) or the Comments panel (open comments). */
export function focusReview(target: "decide" | "comments") {
  const s = useEditor.getState();
  s.set("panels", { ...s.panels, right: target === "decide" ? "process" : "review" });
  s.set("reviewFocus", { target, at: Date.now() });
}

function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Runs a next-step action from the header or the workflow card ("recall" is handled by the card). */
export function runFlowAction(a: FlowAction, ui: EditorUI) {
  const v = useEditor.getState().version;
  if (!v) return;
  switch (a.kind) {
    case "submit":
      return ui.openDialog("submit");
    case "decide":
      return focusReview("decide");
    case "comments":
      return focusReview("comments");
    case "clearAi":
      return focusReview("decide");
    case "release":
      return ui.openDialog("release");
    case "newVersion":
      return ui.openDialog("newVersion");
    case "releasePdf":
      return download(`/api/versions/${v.versionId}/release.pdf`);
    case "recall":
      return focusReview("decide");
  }
}
