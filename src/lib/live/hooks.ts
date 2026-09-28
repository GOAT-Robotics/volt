/**
 * Hooks into the live collaboration hub for code that reads or freezes a version. The hub
 * registers itself when it is first used, so importing this never pulls the hub in.
 */
export const liveHooks: {
  /** save a live room's unsaved changes before the version is read from the database */
  flush?: (versionId: string) => Promise<void>;
  /** the version stopped being editable (submitted, released …): tell everyone in the room */
  readonly?: (versionId: string, reason: string) => void;
} = {};

export const flushLive = (versionId: string) => liveHooks.flush?.(versionId) ?? Promise.resolve();
export const liveReadonly = (versionId: string, reason: string) => liveHooks.readonly?.(versionId, reason);
