export type ApprovalPolicy = {
  minApprovals: number;
  sequentialDefault: boolean;
  allowSelfApproval: boolean;
  requireCommentsResolved: boolean;
  approvalExpiryDays: number | null;
  signatureRequiredForRelease: boolean;
  requiredSignatories: number;
  editSubmitted: "forbid" | "newVersion";
};

export type WorkspaceSettings = {
  guestPolicy: "deny" | "reviewOnly" | "allow";
  sessionHours: number;
  signReauthMinutes: number;
  approval: ApprovalPolicy;
  signature: { provider: "builtin"; statement: string; expiryDays: number };
  exports: { viewerCanExport: boolean; guestCanExport: boolean; formats: string[] };
  retention: { archiveAfterDays: number | null; deleteAutosavesAfterDays: number; keepAuditYears: number };
  notifications: { email: boolean; teamsWebhook: string | null };
  qetBaseline: string;
  autosaveSeconds: number;
  library: { requireApprovalForOrg: boolean };
  versionScheme: "INTEGER" | "DECIMAL" | "LETTER" | "CUSTOM";
  /**
   * What a shared link shows in Teams, Slack, Outlook … (their servers fetch it without signing in):
   * "off" — only "Volt"; "name" — project / component name; "picture" — name and a picture of the
   * title page or symbol.
   */
  linkPreviews: "off" | "name" | "picture";
};

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  guestPolicy: "reviewOnly",
  sessionHours: 12,
  signReauthMinutes: 10,
  approval: {
    minApprovals: 1,
    sequentialDefault: false,
    allowSelfApproval: false,
    requireCommentsResolved: true,
    approvalExpiryDays: null,
    signatureRequiredForRelease: true,
    requiredSignatories: 1,
    editSubmitted: "newVersion",
  },
  signature: {
    provider: "builtin",
    statement: "I have reviewed this drawing version and approve it for release. I understand this electronic signature is attributable to me.",
    expiryDays: 14,
  },
  exports: { viewerCanExport: true, guestCanExport: false, formats: ["pdf", "svg", "png", "qet", "dxf"] },
  retention: { archiveAfterDays: null, deleteAutosavesAfterDays: 30, keepAuditYears: 10 },
  notifications: { email: false, teamsWebhook: null },
  qetBaseline: "0.100",
  autosaveSeconds: 4,
  library: { requireApprovalForOrg: true },
  versionScheme: "INTEGER",
  linkPreviews: "picture",
};

export function parseSettings(s: string | null | undefined): WorkspaceSettings {
  let v: Partial<WorkspaceSettings> = {};
  try {
    v = JSON.parse(s || "{}");
  } catch {}
  return {
    ...DEFAULT_SETTINGS,
    ...v,
    approval: { ...DEFAULT_SETTINGS.approval, ...(v.approval ?? {}) },
    signature: { ...DEFAULT_SETTINGS.signature, ...(v.signature ?? {}) },
    exports: { ...DEFAULT_SETTINGS.exports, ...(v.exports ?? {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(v.retention ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(v.notifications ?? {}) },
    library: { ...DEFAULT_SETTINGS.library, ...(v.library ?? {}) },
  };
}
