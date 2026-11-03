"use client";
import { useCallback, useEffect, useState } from "react";
import { useEditor } from "../store";
import { api } from "@/lib/fetcher";
import { refreshFlow } from "./flow";
import { WorkflowCard } from "./WorkflowCard";
import { AiReviewBox, ReviewBox, VersionChanges, type ReviewInfo } from "./ReviewPanel";

/**
 * The Review panel (its own menu, apart from the comments): where the version is in
 * draft → approvals → release, approving and signing, what changed, and the AI reviewer.
 */
export function ReviewProcessPanel() {
  const v = useEditor((s) => s.version);
  const focus = useEditor((s) => s.reviewFocus);
  const [review, setReview] = useState<ReviewInfo | null>(null);

  const load = useCallback(async () => {
    if (!v) return;
    api<ReviewInfo>(`/api/versions/${v.versionId}/review`)
      .then(setReview)
      .catch(() => setReview(null));
    void refreshFlow();
  }, [v]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  // "Approve & sign" from the header or the card: bring the decision box into view
  useEffect(() => {
    if (!focus || focus.target !== "decide") return;
    const el = document.getElementById("volt-review-decide");
    if (!el) return; // not rendered yet: tried again when the review has loaded
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    (el.querySelector("input") ?? el.querySelector("textarea"))?.focus({ preventScroll: true });
    useEditor.getState().set("reviewFocus", null);
  }, [focus, review]);

  if (!v) return null;
  return (
    <div className="flex flex-col">
      <WorkflowCard />
      {review?.review && <ReviewBox info={review} reload={load} />}
      <VersionChanges versionId={v.versionId} />
      <AiReviewBox versionId={v.versionId} onDone={load} />
    </div>
  );
}
