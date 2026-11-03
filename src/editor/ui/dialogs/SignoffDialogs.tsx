"use client";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { refreshFlow } from "../flow";
import { api } from "@/lib/fetcher";
import { PromptDialog } from "@/components/volt/common";

/** Release a version approved under the earlier process (new approvals release by themselves). */
export function ReleaseDialog({ onClose }: { onClose: () => void }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  if (!v) return null;
  return (
    <PromptDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Release v${v.label}?`}
      description="It becomes the released drawing of record for this line; an earlier release of the line is marked superseded. Everyone following this project is notified."
      confirmLabel="Release"
      reason
      reasonLabel="Release note"
      reasonRequired={false}
      onConfirm={async (note) => {
        try {
          await api(`/api/versions/${v.versionId}/release`, { method: "POST", json: { note } });
          ui.toast(`v${v.label} released — it is now the drawing of record`, { tone: "success" });
          await refreshFlow();
          onClose();
        } catch (e) {
          ui.toast((e as Error).message, { tone: "error" });
        }
      }}
    />
  );
}
