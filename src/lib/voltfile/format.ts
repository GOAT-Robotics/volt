/**
 * The .volt file: a Volt project — or one version of it — together with its reviews, in one file
 * that can be downloaded, shared and uploaded into any Volt server. Specification:
 * docs/VOLT_FORMAT.md.
 *
 * A .volt file is a ZIP archive:
 *
 *   mimetype                 "application/vnd.volt+zip" (first entry, stored)
 *   manifest.json            what is inside + SHA-256 of every other entry
 *   seal.json                Ed25519 signature of the exporting server over manifest.json
 *   README.txt               a note for people who open the archive by hand
 *   project.json             project + variants
 *   versions.json            version records (status, dates, authors, lineage)
 *   drawings/<versionId>.json  the drawing (Volt document) of each version
 *   commits.json, history/<commitId>.json   commit history (whole-project files)
 *   comments.json, reviews.json, signatures.json
 *   files.json, files/<id>/<name>           attachments and component datasheets
 *
 * Records keep their ids from the exporting server. A record that has travelled through several
 * servers carries its `lineage`: the "<server key id>/<record id>" keys it had on earlier servers.
 * That is how a reviewed copy is recognised when it comes back (merge reviews back), and how the
 * same comment is never merged twice.
 *
 * This module has no database or server dependencies (tests use it directly).
 */
import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from "fflate";
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@/core/stable-json";
import type { Doc } from "@/core/model";

export const VOLT_MIME = "application/vnd.volt+zip";
export const VOLT_FORMAT_VERSION = 1;
export const VOLT_EXTENSION = ".volt";

/** upload limit for a .volt file */
export const MAX_VOLT_FILE = 100 * 1024 * 1024;
/** zip-bomb guards: everything unpacked, and one entry */
const MAX_UNPACKED = 600 * 1024 * 1024;
const MAX_ENTRY = 80 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

const s = (n: number) => z.string().max(n);
const date = z.string().max(40).nullable();
const id = s(120);

export const Person = z.object({ id, name: s(300), email: s(320).optional(), bot: z.boolean().optional() });
export type Person = z.infer<typeof Person>;

/** "<server key id>/<record id>" — a record's identity on one Volt server */
export const keyOf = (server: string, recordId: string) => `${server}/${recordId}`;
const Lineage = z.array(s(300)).max(50).default([]);

export const VoltProject = z.object({
  id,
  name: s(300),
  number: s(100).nullable(),
  description: s(10_000).default(""),
  tags: z.array(s(60)).max(50).default([]),
  versionScheme: s(20).default("INTEGER"),
  customScheme: s(100).nullable().default(null),
  createdAt: date,
  createdBy: Person,
});
export type VoltProject = z.infer<typeof VoltProject>;

export const VoltVariant = z.object({
  id,
  code: s(40),
  name: s(200),
  customer: s(300).default(""),
  description: s(10_000).default(""),
  baseVersionId: s(120).nullable(),
  baseLabel: s(100),
  state: s(20).default("ACTIVE"),
  createdAt: date,
  createdBy: Person,
});
export type VoltVariant = z.infer<typeof VoltVariant>;

/** signature record from the exporting server (or carried from an earlier one) */
export const VoltSignature = z.object({
  id,
  versionId: id,
  signatory: Person,
  purpose: s(500).default(""),
  order: z.number().int().default(0),
  status: s(30),
  docHash: s(100).default(""),
  pdfHash: s(100).nullable().default(null),
  provider: s(60).default("builtin"),
  signedAt: date.default(null),
  declineReason: s(5000).nullable().default(null),
  createdAt: date.default(null),
  /** evidence + seal: only when the person exporting may see them (project managers) */
  evidence: z.record(z.string(), z.unknown()).nullable().default(null),
  seal: s(2000).nullable().default(null),
  /** set when this record was itself imported from a file: where it was made, and what the check said then */
  importedFrom: z.object({ server: s(300), sealValid: z.boolean().nullable() }).nullable().default(null),
});
export type VoltSignature = z.infer<typeof VoltSignature>;

export const VoltVersion = z.object({
  id,
  seq: z.number().int().min(1).max(1_000_000),
  label: s(100),
  /** status at the exporting server (for imported records: the status they had where they were made) */
  status: s(30),
  variantId: s(120).nullable().default(null),
  parentId: s(120).nullable().default(null),
  summary: s(2000).default(""),
  description: s(20_000).default(""),
  ticket: s(200).nullable().default(null),
  createdBy: Person,
  createdAt: date,
  submittedAt: date.default(null),
  approvedAt: date.default(null),
  signedAt: date.default(null),
  releasedAt: date.default(null),
  endedAt: date.default(null),
  endReason: s(2000).nullable().default(null),
  docHash: s(100),
  headCommitId: s(120).nullable().default(null),
  baseCommitId: s(120).nullable().default(null),
  lineage: Lineage,
  /** the server where this status was given, when not the exporting one */
  statusFrom: s(300).nullable().default(null),
});
export type VoltVersion = z.infer<typeof VoltVersion>;

export const VoltCommit = z.object({
  id,
  versionId: id,
  parentId: s(120).nullable().default(null),
  seq: z.number().int().min(1),
  kind: s(20).default("COMMIT"),
  message: s(2000).default(""),
  docHash: s(100),
  author: Person,
  createdAt: date,
});
export type VoltCommit = z.infer<typeof VoltCommit>;

export const VoltAnchor = z.object({
  type: z.enum(["element", "wire", "text", "region", "point"]),
  id: s(200).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().optional(),
  h: z.number().finite().optional(),
});

export const VoltComment = z.object({
  id,
  versionId: s(120).nullable(),
  pageId: s(100).nullable().default(null),
  anchor: VoltAnchor.nullable().default(null),
  parentId: s(120).nullable().default(null),
  body: s(10_000),
  status: s(20).default("OPEN"),
  author: Person,
  createdAt: date,
  updatedAt: date.default(null),
  lineage: Lineage,
  /** server where the comment was written, when not the exporting one */
  from: s(300).nullable().default(null),
});
export type VoltComment = z.infer<typeof VoltComment>;

export const VoltAssignment = z.object({
  id,
  order: z.number().int().default(0),
  who: Person.nullable().default(null),
  group: s(300).nullable().default(null),
  canApprove: z.boolean().default(true),
  decision: s(30).default("PENDING"),
  reason: s(5000).nullable().default(null),
  decidedBy: Person.nullable().default(null),
  decidedAt: date.default(null),
});
export type VoltAssignment = z.infer<typeof VoltAssignment>;

export const VoltReview = z.object({
  id,
  versionId: id,
  status: s(30),
  instructions: s(10_000).default(""),
  dueDate: date.default(null),
  sequential: z.boolean().default(false),
  submittedBy: Person,
  createdAt: date,
  closedAt: date.default(null),
  commitId: s(120).nullable().default(null),
  assignments: z.array(VoltAssignment).max(500).default([]),
  lineage: Lineage,
  from: s(300).nullable().default(null),
});
export type VoltReview = z.infer<typeof VoltReview>;

/** an attachment (comment, review, project, release) or a component document (datasheet …) */
export const VoltFile = z.object({
  id,
  kind: z.enum(["attachment", "document"]),
  /** archive entry with the bytes; null for documents that are only a link */
  path: s(400).nullable(),
  filename: s(300).nullable().default(null),
  mime: s(200).nullable().default(null),
  size: z.number().int().min(0).nullable().default(null),
  sha256: s(100).nullable().default(null),
  createdAt: date,
  uploadedBy: Person,
  ownerType: s(20).nullable().default(null),
  ownerId: s(120).nullable().default(null),
  docKind: s(30).nullable().default(null),
  title: s(500).nullable().default(null),
  url: s(2000).nullable().default(null),
  elementId: s(200).nullable().default(null),
  manufacturer: s(300).nullable().default(null),
  partNumber: s(300).nullable().default(null),
});
export type VoltFile = z.infer<typeof VoltFile>;

export const VoltManifest = z.object({
  format: z.literal("volt"),
  formatVersion: z.number().int().min(1),
  scope: z.enum(["project", "version"]),
  createdAt: s(40),
  generator: s(200).default("Volt"),
  server: z.object({ keyId: s(200), name: s(300), url: s(500).nullable().default(null) }),
  exportedBy: Person,
  project: z.object({ id, name: s(300), number: s(100).nullable() }),
  versions: z.array(z.object({ id, label: s(100), status: s(30), variant: s(40).nullable().default(null), docHash: s(100) })).max(5000),
  includes: z.object({ reviews: z.boolean(), history: z.boolean(), files: z.boolean() }),
  counts: z.object({ versions: z.number().int(), commits: z.number().int(), comments: z.number().int(), reviews: z.number().int(), signatures: z.number().int(), files: z.number().int() }),
  entries: z.record(s(400), z.object({ sha256: s(64), size: z.number().int().min(0) })),
});
export type VoltManifest = z.infer<typeof VoltManifest>;

export const VoltSeal = z.object({ alg: z.literal("Ed25519"), keyId: s(200), publicKey: s(2000), signature: s(400) });
export type VoltSeal = z.infer<typeof VoltSeal>;

/** everything a .volt file holds, parsed */
export type VoltBundle = {
  project: VoltProject;
  variants: VoltVariant[];
  versions: VoltVersion[];
  drawings: Map<string, Doc>;
  commits: VoltCommit[];
  history: Map<string, Doc>;
  comments: VoltComment[];
  reviews: VoltReview[];
  signatures: VoltSignature[];
  files: VoltFile[];
  fileData: Map<string, Uint8Array>;
};

export type VoltHeader = Omit<VoltManifest, "entries" | "counts" | "format" | "formatVersion" | "versions">;

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

export type SealKey = { priv: KeyObject; keyId: string; pubPem: string };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const json = (v: unknown) => strToU8(JSON.stringify(v));

/** archive-safe file name */
export function safeName(name: string | null | undefined, fallback = "file") {
  const base = (name ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f<>:"|?*]+/g, "_").replace(/^\.+/, "").trim().slice(0, 150);
  return base || fallback;
}

const README = (m: VoltManifest) =>
  [
    `Volt project file — ${m.project.name}${m.project.number ? ` (${m.project.number})` : ""}`,
    ``,
    `Exported ${m.createdAt} by ${m.exportedBy.name} from ${m.server.name}${m.server.url ? ` (${m.server.url})` : ""}.`,
    m.scope === "version" ? `Contains version ${m.versions.map((v) => v.label).join(", ")} of the project.` : `Contains the whole project: ${m.versions.length} version(s).`,
    m.includes.reviews ? `Includes review comments, review decisions and signature records.` : `Reviews and comments are not included.`,
    ``,
    `To open it: in Volt, go to Projects → Import and choose this file. To send a reviewed copy back,`,
    `export it from Volt again and import it into the original project ("Merge reviews back").`,
    ``,
    `Do not edit the files inside: manifest.json lists the SHA-256 of every entry and seal.json`,
    `signs the manifest with the exporting server's Ed25519 key, so changes are detected.`,
    `Format: docs/VOLT_FORMAT.md in the Volt source code.`,
    ``,
  ].join("\n");

/** Build a sealed .volt archive. */
export function packVolt(header: VoltHeader, b: VoltBundle, key: SealKey): { bytes: Uint8Array; manifest: VoltManifest } {
  const entries: Record<string, Uint8Array> = {};
  entries["project.json"] = json({ project: b.project, variants: b.variants });
  entries["versions.json"] = json(b.versions);
  for (const v of b.versions) {
    const d = b.drawings.get(v.id);
    if (d) entries[`drawings/${v.id}.json`] = json(d);
  }
  if (header.includes.history) {
    entries["commits.json"] = json(b.commits);
    for (const c of b.commits) {
      const d = b.history.get(c.id);
      if (d) entries[`history/${c.id}.json`] = json(d);
    }
  }
  if (header.includes.reviews) {
    entries["comments.json"] = json(b.comments);
    entries["reviews.json"] = json(b.reviews);
    entries["signatures.json"] = json(b.signatures);
  }
  if (header.includes.files) {
    const files: VoltFile[] = [];
    for (const f of b.files) {
      const data = b.fileData.get(f.id);
      const path = data ? `files/${f.id}/${safeName(f.filename)}` : null;
      if (data && path) entries[path] = data;
      files.push({ ...f, path, size: data ? data.byteLength : f.size, sha256: data ? sha(data) : f.sha256 });
    }
    entries["files.json"] = json(files);
  }
  const manifest: VoltManifest = {
    format: "volt",
    formatVersion: VOLT_FORMAT_VERSION,
    ...header,
    versions: b.versions.map((v) => ({ id: v.id, label: v.label, status: v.status, variant: b.variants.find((x) => x.id === v.variantId)?.code ?? null, docHash: v.docHash })),
    counts: {
      versions: b.versions.length,
      commits: header.includes.history ? b.commits.length : 0,
      comments: header.includes.reviews ? b.comments.length : 0,
      reviews: header.includes.reviews ? b.reviews.length : 0,
      signatures: header.includes.reviews ? b.signatures.length : 0,
      files: header.includes.files ? b.files.length : 0,
    },
    entries: {},
  };
  // the README is covered by the manifest too (it names the project and the exporter)
  const readme = strToU8(README(manifest));
  entries["README.txt"] = readme;
  for (const [p, d] of Object.entries(entries)) manifest.entries[p] = { sha256: sha(d), size: d.byteLength };
  const manifestBytes = strToU8(stableStringify(manifest));
  const seal: VoltSeal = { alg: "Ed25519", keyId: key.keyId, publicKey: key.pubPem, signature: sign(null, manifestBytes, key.priv).toString("base64") };
  // insertion order is archive order: mimetype first and stored, like ODF / EPUB
  const zip: Zippable = {
    mimetype: [strToU8(VOLT_MIME), { level: 0 }],
    "manifest.json": manifestBytes,
    "seal.json": json(seal),
    "README.txt": readme,
  };
  for (const [p, d] of Object.entries(entries)) if (p !== "README.txt") zip[p] = d;
  return { bytes: zipSync(zip, { level: 6, mtime: new Date(manifest.createdAt) }), manifest };
}

/* ------------------------------------------------------------------ */
/* Reading                                                              */
/* ------------------------------------------------------------------ */

/** a problem the person can understand (file is not a .volt, damaged, too large …) */
export class VoltError extends Error {}

export type VoltCheck = {
  /** every entry listed in the manifest is present and has its SHA-256 */
  intact: boolean;
  /** seal.json present */
  sealed: boolean;
  /** the seal matches the manifest and the key it names */
  sealValid: boolean;
  keyId: string | null;
  /** the sealing key (PEM), to check signature evidence sealed by the same server */
  publicKey: string | null;
  problems: string[];
};

/** "ed25519:" + the first 32 hex digits of the SHA-256 of the public key (SPKI DER) — as lib/signing/builtin */
export function keyIdOf(pubPem: string) {
  const der = createPublicKey(pubPem).export({ format: "der", type: "spki" });
  return "ed25519:" + createHash("sha256").update(der).digest("hex").slice(0, 32);
}

function verifySeal(manifestBytes: Uint8Array, manifest: VoltManifest, sealRaw: unknown): Omit<VoltCheck, "intact"> {
  if (sealRaw === undefined) return { sealed: false, sealValid: false, keyId: null, publicKey: null, problems: ["The file is not sealed"] };
  const p = VoltSeal.safeParse(sealRaw);
  if (!p.success) return { sealed: true, sealValid: false, keyId: null, publicKey: null, problems: ["The seal cannot be read"] };
  const seal = p.data;
  const out = (sealValid: boolean, problem?: string) => ({ sealed: true, sealValid, keyId: seal.keyId, publicKey: sealValid ? seal.publicKey : null, problems: problem ? [problem] : [] });
  try {
    const pub = createPublicKey(seal.publicKey);
    if (pub.asymmetricKeyType !== "ed25519") return out(false, "The seal does not use an Ed25519 key");
    if (keyIdOf(seal.publicKey) !== seal.keyId) return out(false, "The seal's key id does not match its public key");
    if (seal.keyId !== manifest.server.keyId) return out(false, "The file was sealed by a different server than the one it names");
    // the manifest is signed in its canonical form: check that form, not the stored bytes' layout
    const canonical = strToU8(stableStringify(manifest));
    const ok = verify(null, canonical, pub, Buffer.from(seal.signature, "base64")) || verify(null, manifestBytes, pub, Buffer.from(seal.signature, "base64"));
    return out(ok, ok ? undefined : "The seal does not match the file's contents");
  } catch (e) {
    return out(false, `The seal could not be checked: ${(e as Error).message}`);
  }
}

function parseJson(bytes: Uint8Array | undefined, what: string): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new VoltError(`${what} in the file is not valid JSON`);
  }
}

function parseList<T>(schema: z.ZodType<T>, raw: unknown, what: string): T[] {
  if (raw === undefined) return [];
  const r = z.array(schema).safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new VoltError(`${what} in the file are not valid (${i?.path.join(".") || "?"}: ${i?.message ?? "invalid"})`);
  }
  return r.data;
}

/** the minimum a drawing must have to open in the editor (as the document save route) */
const DocShape = z
  .object({
    schema: z.literal(1),
    meta: z.object({ title: z.string() }).passthrough(),
    pages: z.array(z.object({ id: z.string(), elements: z.array(z.unknown()), wires: z.array(z.unknown()), texts: z.array(z.unknown()) }).passthrough()).min(1),
    defs: z.record(z.string(), z.unknown()),
  })
  .passthrough();

function parseDocEntry(bytes: Uint8Array | undefined, what: string): Doc | null {
  const raw = parseJson(bytes, what);
  if (raw === undefined) return null;
  const r = DocShape.safeParse(raw);
  if (!r.success) throw new VoltError(`${what} is not a Volt drawing (${r.error.issues[0]?.message ?? "invalid"})`);
  return r.data as unknown as Doc;
}

/**
 * Read a .volt archive: integrity (hashes), seal, records. Throws VoltError for files that are
 * not .volt files, are damaged or changed after export, or are too large to unpack.
 */
export function readVolt(bytes: Uint8Array): { manifest: VoltManifest; bundle: VoltBundle; check: VoltCheck } {
  if (bytes.byteLength > MAX_VOLT_FILE) throw new VoltError(`The file exceeds the ${MAX_VOLT_FILE / 1024 / 1024} MB limit`);
  let raw: Record<string, Uint8Array>;
  let budget = MAX_UNPACKED;
  let count = 0;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        if (++count > MAX_ENTRIES) throw new VoltError("The file has too many entries");
        if (f.originalSize > MAX_ENTRY) throw new VoltError(`${f.name} in the file is larger than ${MAX_ENTRY / 1024 / 1024} MB`);
        budget -= f.originalSize;
        if (budget < 0) throw new VoltError(`The file unpacks to more than ${MAX_UNPACKED / 1024 / 1024} MB`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof VoltError) throw e;
    throw new VoltError("This is not a .volt file (it is not a ZIP archive)");
  }
  const manifestBytes = raw["manifest.json"];
  if (!manifestBytes) throw new VoltError("This is not a .volt file (manifest.json is missing)");
  const mp = VoltManifest.safeParse(parseJson(manifestBytes, "manifest.json"));
  if (!mp.success) {
    const fmt = (parseJson(manifestBytes, "manifest.json") as { format?: unknown } | null)?.format;
    throw new VoltError(fmt === "volt" ? `The manifest is not valid (${mp.error.issues[0]?.path.join(".")}: ${mp.error.issues[0]?.message})` : "This is not a .volt file");
  }
  const manifest = mp.data;
  if (manifest.formatVersion > VOLT_FORMAT_VERSION) throw new VoltError(`This file was made by a newer Volt (format ${manifest.formatVersion}; this server reads up to ${VOLT_FORMAT_VERSION}). Update Volt to open it.`);

  // integrity: every listed entry, unchanged; entries not listed are ignored
  const problems: string[] = [];
  for (const [p, e] of Object.entries(manifest.entries)) {
    const d = raw[p];
    if (!d) problems.push(`${p} is missing`);
    else if (d.byteLength !== e.size || sha(d) !== e.sha256) problems.push(`${p} was changed`);
  }
  const intact = problems.length === 0;
  const sealCheck = verifySeal(manifestBytes, manifest, parseJson(raw["seal.json"], "seal.json"));
  const check: VoltCheck = { intact, ...sealCheck, problems: [...problems, ...sealCheck.problems] };
  if (!intact) throw new VoltError(`The file was changed or damaged after it was exported (${problems.slice(0, 3).join(", ")}${problems.length > 3 ? " …" : ""}). Ask for a new export.`);
  const listed = (p: string) => (manifest.entries[p] ? raw[p] : undefined);

  const pj = parseJson(listed("project.json"), "project.json") as { project?: unknown; variants?: unknown } | undefined;
  if (!pj?.project) throw new VoltError("project.json is missing from the file");
  const pp = VoltProject.safeParse(pj.project);
  if (!pp.success) throw new VoltError(`The project record is not valid (${pp.error.issues[0]?.message})`);
  const versions = parseList(VoltVersion, parseJson(listed("versions.json"), "versions.json"), "Version records");
  if (!versions.length) throw new VoltError("The file contains no versions");
  if (new Set(versions.map((v) => v.seq)).size !== versions.length) throw new VoltError("Version numbers in the file are not unique");
  const drawings = new Map<string, Doc>();
  for (const v of versions) {
    const d = parseDocEntry(listed(`drawings/${v.id}.json`), `The drawing of v${v.label}`);
    if (!d) throw new VoltError(`The drawing of v${v.label} is missing from the file`);
    drawings.set(v.id, d);
  }
  const commits = parseList(VoltCommit, parseJson(listed("commits.json"), "commits.json"), "Commit records");
  const history = new Map<string, Doc>();
  for (const c of commits) {
    const d = parseDocEntry(listed(`history/${c.id}.json`), `Commit #${c.seq}`);
    if (d) history.set(c.id, d);
  }
  const files = parseList(VoltFile, parseJson(listed("files.json"), "files.json"), "File records");
  const fileData = new Map<string, Uint8Array>();
  for (const f of files) {
    const d = f.path ? listed(f.path) : undefined;
    if (d) fileData.set(f.id, d);
  }
  const bundle: VoltBundle = {
    project: pp.data,
    variants: parseList(VoltVariant, pj.variants ?? [], "Variants"),
    versions: versions.sort((a, b) => a.seq - b.seq),
    drawings,
    commits: commits.filter((c) => history.has(c.id)).sort((a, b) => a.seq - b.seq),
    history,
    comments: parseList(VoltComment, parseJson(listed("comments.json"), "comments.json"), "Comments"),
    reviews: parseList(VoltReview, parseJson(listed("reviews.json"), "reviews.json"), "Reviews"),
    signatures: parseList(VoltSignature, parseJson(listed("signatures.json"), "signatures.json"), "Signature records"),
    files,
    fileData,
  };
  return { manifest, bundle, check };
}

const WORKING = ["DRAFT", "CHANGES_REQUESTED"];

/** newest version of each line stays a working version when it was one; everything else is a read-only record */
export function importStatuses(versions: VoltVersion[]): Map<string, "DRAFT" | "IMPORTED"> {
  const out = new Map<string, "DRAFT" | "IMPORTED">();
  const newest = new Map<string, VoltVersion>();
  for (const v of versions) {
    const line = v.variantId ?? "";
    const cur = newest.get(line);
    if (!cur || v.seq > cur.seq) newest.set(line, v);
  }
  for (const v of versions) out.set(v.id, newest.get(v.variantId ?? "") === v && WORKING.includes(v.status) && !v.statusFrom ? "DRAFT" : "IMPORTED");
  return out;
}

/** all keys a record is known by: earlier servers' (lineage) and the exporting server's */
export const keysOf = (rec: { id: string; lineage: string[] }, server: string) => [...rec.lineage, keyOf(server, rec.id)];

/** looks like a .volt file (by its first bytes): ZIP with the mimetype entry first */
export function looksLikeVolt(head: Uint8Array) {
  if (head.length < 38 || head[0] !== 0x50 || head[1] !== 0x4b) return false;
  return strFromU8(head.subarray(30, 38)) === "mimetype";
}
