/** Shapes shared by the live client and the UI (mirror of src/lib/live/hub.ts, no server imports). */
import type { Pt } from "@/core/model";
import type { Sel } from "@/core/ops";

export type LiveMode = "edit" | "view";
export type PeerSel = Pick<Sel, "elements" | "wires" | "texts" | "junctions" | "shapes">;
export type Peer = {
  clientId: string;
  userId: string;
  name: string;
  email: string;
  color: string;
  canEdit: boolean;
  since: number;
  pageId?: string | null;
  cursor?: Pt | null;
  sel?: PeerSel | null;
  view?: { cx: number; cy: number; s: number } | null;
  drag?: { sel: PeerSel | null; dx: number; dy: number } | null;
  mode?: LiveMode;
};
export type LiveState = { status: "off" | "connecting" | "live" | "offline"; clientId: string | null; color: string | null; error?: string | null };
