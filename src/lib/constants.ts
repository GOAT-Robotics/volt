/** Client-safe shared constants for Volt pages & routes. */
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
  "admin.backup": "Backed up the database",
  "project.folder": "Changed folders",
};
