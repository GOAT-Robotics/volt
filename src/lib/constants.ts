/** Client-safe shared constants for Volt pages & routes. */
export const PROJECT_ROLES = ["OWNER", "DESIGNER", "REVIEWER", "APPROVER", "SIGNATORY", "VIEWER", "GUEST"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const VERSION_SCHEMES = [
  { id: "INTEGER", label: "Integer (1, 2, 3)" },
  { id: "DECIMAL", label: "Decimal (0.1, 0.2)" },
  { id: "LETTER", label: "Letter (A, B, C)" },
  { id: "CUSTOM", label: "Custom pattern (e.g. R{n})" },
] as const;

/** Audit labels not in src/lib/audit.ts. */
export const EXTRA_AUDIT_LABELS: Record<string, string> = {
  "project.delete": "Deleted project",
  "admin.retention": "Ran retention cleanup",
  "project.folder": "Changed folders",
};
