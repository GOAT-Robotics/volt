/**
 * Shapes shared by the .volt import/export code, the API and the UI (no server dependencies).
 * The JSON blobs stored on imported records (Version.imported, Comment.externalAuthor …) use
 * these types.
 */
import type { CompatReport } from "@/core/model";

/** someone named in a .volt file who is not (or not provably) an account on this server */
export type ExternalPerson = { name: string; email?: string; bot?: boolean };
export type ExternalAuthor = ExternalPerson & { server: string };

/** signature record carried on an imported version (never a Signature row: it does not count here) */
export type ImportedSignature = {
  signatory: ExternalPerson;
  purpose: string;
  order: number;
  status: string;
  signedAt: string | null;
  declineReason: string | null;
  docHash: string;
  pdfHash: string | null;
  provider: string;
  /** server whose signing process produced it */
  server: string;
  /** the evidence seal checked against the key that sealed the file: true / false, null = could not be checked */
  sealValid: boolean | null;
  evidence: Record<string, unknown> | null;
  seal: string | null;
};

/** Version.imported */
export type VersionImport = {
  /** status the version had where it was made (it is IMPORTED or a working version here) */
  status: string;
  /** name of the server that exported the file, and of the server that gave the status (may differ) */
  server: string;
  statusFrom: string;
  serverKeyId: string;
  file: string;
  importedAt: string;
  importedBy: string;
  /** lineage: "<server key>/<version id>" keys this version had on other servers */
  keys: string[];
  /** author when not an account here */
  createdBy: ExternalPerson | null;
  /** the file was sealed by this server (people in it are accounts here) */
  trusted: boolean;
  signatures: ImportedSignature[];
};

/** Review.imported */
export type ReviewImport = { status: string; submittedBy: ExternalPerson; from: string; keys: string[] };
/** ReviewAssignment.imported */
export type AssignmentImport = { who: ExternalPerson | null; group: string | null; decidedBy: ExternalPerson | null };

export type SealState = "this-server" | "valid" | "unsealed" | "invalid";

export type MergeCandidate = {
  projectId: string;
  projectName: string;
  projectNumber: string | null;
  versionId: string;
  label: string;
  status: string;
  /** label of the reviewed copy in the file */
  fileLabel: string;
  newThreads: number;
  newReplies: number;
  decisions: number;
  files: number;
  /** AI reviewer findings made on the other server: not merged (this server runs its own) */
  automated: number;
  /** the drawing in the file differs from this version's drawing */
  drawingChanged: boolean;
  canMerge: boolean;
  reason?: string;
};

export type VoltInspection = {
  file: { name: string; size: number; sha256: string };
  scope: "project" | "version";
  createdAt: string;
  server: { name: string; url: string | null; keyId: string; thisServer: boolean };
  exportedBy: string;
  seal: { state: SealState; detail: string };
  project: { name: string; number: string | null; description: string; tags: string[] };
  versions: { label: string; status: string; variant: string | null; importsAs: "DRAFT" | "IMPORTED"; comments: number; reviews: number; signatures: number }[];
  counts: { versions: number; commits: number; comments: number; reviews: number; signatures: number; files: number };
  includes: { reviews: boolean; history: boolean; files: boolean };
  report: CompatReport;
  numberTaken: boolean;
  merge: MergeCandidate[];
  canCreate: boolean;
};

export type MergeResult = {
  merged: { projectId: string; versionId: string; label: string; threads: number; replies: number; decisions: number; files: number }[];
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SIGNED: "Signed",
  RELEASED: "Released",
  SUPERSEDED: "Superseded",
  WITHDRAWN: "Withdrawn",
  OBSOLETE: "Obsolete",
  IMPORTED: "Imported",
  OPEN: "Open",
  CANCELLED: "Cancelled",
  RECALLED: "Recalled",
  PENDING: "Pending",
  REQUESTED: "Requested",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  INVALIDATED: "Invalidated",
};
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.toLowerCase().replace(/_/g, " ");

/** parse a JSON column, tolerating junk */
export function jsonOr<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
