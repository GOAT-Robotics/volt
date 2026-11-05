"use client";
/** Align and space a multi-selection (components, texts, shapes, junctions): inspector controls and the shared icon set. */
import { useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Baseline,
  Crosshair,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/misc";
import { useEditor } from "../store";
import { distribute, runCommand } from "./commands";
import { useEditorUI } from "./context";

export const ALIGN_ACTIONS = [
  { id: "align-left", label: "Align left edges", short: "Left", icon: <AlignStartVertical /> },
  { id: "align-center", label: "Align horizontal centres", short: "Centre", icon: <AlignCenterVertical /> },
  { id: "align-right", label: "Align right edges", short: "Right", icon: <AlignEndVertical /> },
  { id: "align-top", label: "Align top edges", short: "Top", icon: <AlignStartHorizontal /> },
  { id: "align-middle", label: "Align vertical middles", short: "Middle", icon: <AlignCenterHorizontal /> },
  { id: "align-bottom", label: "Align bottom edges", short: "Bottom", icon: <AlignEndHorizontal /> },
] as const;

export const CENTRE_ON = { id: "centreOn", label: "Centre on component — horizontally and vertically", icon: <Crosshair /> } as const;

export const CENTRE_LABELS = { id: "centreLabels", label: "Centre labels on symbol — reference and cross-reference on the centre line", icon: <Baseline /> } as const;

export const DISTRIBUTE_ACTIONS = [
  { id: "distH", label: "Distribute horizontally — equal gaps", short: "Space ↔", icon: <AlignHorizontalDistributeCenter /> },
  { id: "distV", label: "Distribute vertically — equal gaps", short: "Space ↕", icon: <AlignVerticalDistributeCenter /> },
] as const;

/** Body of the inspector's "Arrange" section for `count` alignable things. */
export function ArrangeControls({ count, components }: { count: number; components: number }) {
  const ui = useEditorUI();
  const alignTo = useEditor((s) => s.alignTo);
  const setStore = useEditor((s) => s.set);
  const [gap, setGap] = useState("10");
  const run = (id: string) => runCommand(id, ui);
  const g = Number(gap);
  const gapOk = gap.trim() !== "" && Number.isFinite(g) && g >= 0;
  const spaceBy = (axis: "x" | "y") =>
    void useEditor.getState().apply(`Spacing ${g}`, (d) => distribute(d, useEditor.getState(), axis, g));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
        <span className="text-2xs text-muted">Align to</span>
        <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Align to">
          {(
            [
              ["selection", "Selection", "Line up with the outline of everything selected"],
              ["component", "Component", "Line up with the first selected component, which stays put"],
            ] as const
          ).map(([v, l, tip]) => (
            <Tip key={v} content={v === "component" && !components ? "Select a component too" : tip}>
              <Button size="xs" variant={alignTo === v ? "primary" : "secondary"} role="radio" aria-checked={alignTo === v} disabled={v === "component" && !components} onClick={() => setStore("alignTo", v)}>
                {l}
              </Button>
            </Tip>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {ALIGN_ACTIONS.map((a) => (
          <Tip key={a.id} content={a.label}>
            <Button size="icon" variant="secondary" aria-label={a.label} onClick={() => run(a.id)}>
              {a.icon}
            </Button>
          </Tip>
        ))}
      </div>
      {components > 0 && (
        <Button size="xs" variant="secondary" className="w-full" onClick={() => run(CENTRE_LABELS.id)} title="Each component's reference (and an arrow's cross-reference) moves onto its symbol's centre line">
          {CENTRE_LABELS.icon}
          Centre labels on their symbols
        </Button>
      )}
      {components > 0 && (
        <Button size="xs" variant="secondary" className="w-full" onClick={() => run(CENTRE_ON.id)} title="The first selected component stays put; everything else is centred on it">
          {CENTRE_ON.icon}
          Centre on component (↔ and ↕)
        </Button>
      )}
      <div className="grid grid-cols-2 gap-1">
        {DISTRIBUTE_ACTIONS.map((a) => (
          <Tip key={a.id} content={count < 3 ? "Select three or more to space them evenly" : a.label}>
            <Button size="xs" variant="secondary" onClick={() => run(a.id)} disabled={count < 3}>
              {a.icon}
              {a.short} evenly
            </Button>
          </Tip>
        ))}
      </div>
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-1">
        <span className="text-2xs text-muted">Gap</span>
        <Input
          type="number"
          min={0}
          step={5}
          value={gap}
          onChange={(e) => setGap(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Gap between items, drawing units"
        />
        <Button size="xs" variant="secondary" disabled={!gapOk} onClick={() => spaceBy("x")} title="Place them side by side, this far apart (first one stays)">
          ↔
        </Button>
        <Button size="xs" variant="secondary" disabled={!gapOk} onClick={() => spaceBy("y")} title="Stack them, this far apart (first one stays)">
          ↕
        </Button>
      </div>
      <p className="text-2xs text-subtle">
        By visible outline{alignTo === "component" && components ? " of the first selected component" : ""}. Components move in whole grid steps (10) so pins stay on the grid; texts and shapes move exactly. Wires follow.
      </p>
    </div>
  );
}
