import type { TitleBlockLogo } from "@/core/model";

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
  /**
   * Live collaboration. live: several people edit the same version at once and see each other's
   * cursors, selections and changes (off: one editor at a time, saves are checked for conflicts).
   * presence: project lists and pages show who is working in a project right now.
   */
  collaboration: { live: boolean; presence: boolean };
  /**
   * Who sees what. newMemberRole: workspace role for people who sign in from an allowed email
   * domain without an Entra group mapping ("none": they can sign in but have no project capability
   * until an admin assigns a role). projectSharing: who may add or remove project members
   * ("admins": workspace admins only; "owners": project owners too).
   */
  access: { newMemberRole: "none" | "VIEWER" | "DESIGNER"; projectSharing: "admins" | "owners" };
  /**
   * Your organization: shown on the sign-in page and link previews, used as the default company
   * logo of title blocks and cover sheets, and as the manufacturer of new cover sheets.
   */
  branding: { name: string; address: string; url: string; logo: TitleBlockLogo | null };
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
  collaboration: { live: true, presence: true },
  access: { newMemberRole: "none", projectSharing: "admins" },
  branding: { name: "", address: "", url: "", logo: null },
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
    collaboration: { ...DEFAULT_SETTINGS.collaboration, ...(v.collaboration ?? {}) },
    access: { ...DEFAULT_SETTINGS.access, ...(v.access ?? {}) },
    branding: { ...DEFAULT_SETTINGS.branding, ...(v.branding ?? {}) },
  };
}
