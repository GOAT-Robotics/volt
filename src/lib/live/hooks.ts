/**
 * Hooks into the live collaboration hub for code that reads or freezes a version. The hub
 * registers itself when it is first used, so importing this never pulls the hub in.
 */
import type { Doc } from "@/core/model";

type Hooks = {
  /** save a live room's unsaved changes before the version is read from the database */
  flush?: (versionId: string) => Promise<void>;
  /** the version stopped being editable (submitted, released …): tell everyone in the room */
  readonly?: (versionId: string, reason: string) => void;
  /** live collaboration was switched off for a workspace: save and close its rooms */
  disable?: (workspaceId: string) => Promise<void>;
  /**
   * A change made on the server (an assistant via MCP) to a version that has a live room: applied
   * to the room's document and sent to everyone in it. `change` returns the next document (it must
   * not modify the one it gets). Returns null when nobody has the version open.
   */
  edit?: (versionId: string, by: { userId: string; name: string }, change: (doc: Doc) => Doc) => { ops: number } | null;
};
// on globalThis so every route bundle sees the hub's registration
const g = globalThis as unknown as { __voltLiveHooks?: Hooks };
export const liveHooks: Hooks = (g.__voltLiveHooks ??= {});

export const flushLive = (versionId: string) => liveHooks.flush?.(versionId) ?? Promise.resolve();
export const liveReadonly = (versionId: string, reason: string) => liveHooks.readonly?.(versionId, reason);
