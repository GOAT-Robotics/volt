"use client";
import { useState } from "react";
import { SlidersHorizontal, MessageSquare, ShieldCheck, History, PanelRightClose } from "lucide-react";
import { useEditor } from "../store";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import { Inspector } from "./Inspector";
import { ReviewPanel } from "./ReviewPanel";
import { ValidationPanel } from "./ValidationPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Resizer } from "./LeftPanel";

export function RightPanel() {
  const panel = useEditor((s) => s.panels.right);
  const comments = useEditor((s) => s.comments.filter((c) => c.status === "OPEN" || c.status === "REOPENED").length);
  const [w, setW] = useState(300);
  const set = (right: typeof panel) => {
    const s = useEditor.getState();
    s.set("panels", { ...s.panels, right: s.panels.right === right ? null : right });
  };
  const tabs = [
    { id: "inspector", icon: <SlidersHorizontal />, label: "Properties" },
    { id: "review", icon: <MessageSquare />, label: "Comments", badge: comments },
    { id: "validate", icon: <ShieldCheck />, label: "Checks" },
    { id: "history", icon: <History />, label: "History & versions" },
  ] as const;
  return (
    <div className="flex shrink-0">
      {panel && (
        <aside className="relative flex flex-col border-l border-border bg-panel" style={{ width: w }} aria-label={tabs.find((t) => t.id === panel)?.label}>
          <Resizer side="left" onResize={(dx) => setW((x) => Math.min(520, Math.max(240, x + dx)))} />
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <h2 className="text-xs font-semibold">{tabs.find((t) => t.id === panel)?.label}</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Collapse panel" onClick={() => set(panel)}>
              <PanelRightClose />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "inspector" && <Inspector />}
            {panel === "review" && <ReviewPanel />}
            {panel === "validate" && <ValidationPanel />}
            {panel === "history" && <HistoryPanel />}
          </div>
        </aside>
      )}
      <nav className="flex w-11 flex-col items-center gap-1 border-l border-border bg-panel py-2" aria-label="Right panels">
        {tabs.map((t) => (
          <Tip key={t.id} content={t.label} side="left">
            <Button variant="tool" size="icon" active={panel === t.id} aria-pressed={panel === t.id} aria-label={t.label} onClick={() => set(t.id)} className="relative">
              {t.icon}
              {"badge" in t && t.badge > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-purple-600 px-1 text-[9px] font-semibold text-white">{t.badge}</span>}
            </Button>
          </Tip>
        ))}
      </nav>
    </div>
  );
}
