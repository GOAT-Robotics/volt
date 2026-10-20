import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { newDoc } from "@/core/doc";
import { importStatuses, keysOf, looksLikeVolt, packVolt, readVolt, VoltError, VOLT_MIME, type SealKey, type VoltBundle, type VoltHeader, type VoltVersion } from "../format";

function key(): SealKey {
  const kp = generateKeyPairSync("ed25519");
  const der = kp.publicKey.export({ format: "der", type: "spki" });
  return { priv: kp.privateKey, keyId: "ed25519:" + createHash("sha256").update(der).digest("hex").slice(0, 32), pubPem: kp.publicKey.export({ format: "pem", type: "spki" }).toString() };
}

const person = { id: "u1", name: "Dev Designer", email: "designer@example.com" };
const version = (o: Partial<VoltVersion> & { id: string; seq: number }): VoltVersion => ({
  label: String(o.seq),
  status: "DRAFT",
  variantId: null,
  parentId: null,
  summary: "",
  description: "",
  ticket: null,
  createdBy: person,
  createdAt: "2026-10-01T10:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  signedAt: null,
  releasedAt: null,
  endedAt: null,
  endReason: null,
  docHash: "h",
  headCommitId: null,
  baseCommitId: null,
  lineage: [],
  statusFrom: null,
  ...o,
});

function bundle(): VoltBundle {
  const d1 = newDoc("Panel");
  const d2 = newDoc("Panel");
  d2.meta.props.rev = "2";
  return {
    project: { id: "p1", name: "Panel", number: "P-100", description: "Robot control panel", tags: ["robot"], versionScheme: "INTEGER", customScheme: null, createdAt: null, createdBy: person },
    variants: [],
    versions: [version({ id: "v1", seq: 1, status: "RELEASED" }), version({ id: "v2", seq: 2, status: "IN_REVIEW", parentId: "v1" })],
    drawings: new Map([
      ["v1", d1],
      ["v2", d2],
    ]),
    commits: [],
    history: new Map(),
    comments: [
      { id: "c1", versionId: "v2", pageId: d2.pages[0].id, anchor: { type: "point", x: 10, y: 20 }, parentId: null, body: "Check the fuse rating", status: "OPEN", author: { id: "u2", name: "Riya Reviewer" }, createdAt: "2026-10-02T09:00:00.000Z", updatedAt: null, lineage: [], from: null },
      { id: "c2", versionId: "v2", pageId: d2.pages[0].id, anchor: null, parentId: "c1", body: "Done", status: "OPEN", author: person, createdAt: "2026-10-02T10:00:00.000Z", updatedAt: null, lineage: [], from: null },
    ],
    reviews: [],
    signatures: [],
    files: [{ id: "f1", kind: "attachment", path: null, filename: "spec.pdf", mime: "application/pdf", size: 4, sha256: null, createdAt: null, uploadedBy: person, ownerType: "PROJECT", ownerId: "p1", docKind: null, title: null, url: null, elementId: null, manufacturer: null, partNumber: null }],
    fileData: new Map([["f1", strToU8("%PDF")]]),
  };
}

const header = (k: SealKey, scope: "project" | "version" = "project"): VoltHeader => ({
  scope,
  createdAt: "2026-10-20T08:00:00.000Z",
  generator: "Volt",
  server: { keyId: k.keyId, name: "GOAT Robotics", url: "https://volt.example.com" },
  exportedBy: person,
  project: { id: "p1", name: "Panel", number: "P-100" },
  includes: { reviews: true, history: true, files: true },
});

describe(".volt files", () => {
  it("round-trips a project with drawings, comments and files, sealed", () => {
    const k = key();
    const { bytes, manifest } = packVolt(header(k), bundle(), k);
    expect(looksLikeVolt(bytes)).toBe(true);
    const raw = unzipSync(bytes);
    expect(Object.keys(raw)[0]).toBe("mimetype");
    expect(strFromU8(raw.mimetype)).toBe(VOLT_MIME);
    expect(strFromU8(raw["README.txt"])).toContain("Panel (P-100)");

    const r = readVolt(bytes);
    expect(r.check).toMatchObject({ intact: true, sealed: true, sealValid: true, keyId: k.keyId });
    expect(r.manifest.counts).toEqual(manifest.counts);
    expect(r.manifest.versions.map((v) => v.label)).toEqual(["1", "2"]);
    expect(r.bundle.drawings.get("v2")?.meta.props.rev).toBe("2");
    expect(r.bundle.comments.map((c) => c.body)).toEqual(["Check the fuse rating", "Done"]);
    expect(r.bundle.comments[0].anchor).toEqual({ type: "point", x: 10, y: 20 });
    expect(strFromU8(r.bundle.fileData.get("f1")!)).toBe("%PDF");
    expect(r.bundle.files[0].path).toBe("files/f1/spec.pdf");
  });

  it("refuses a file whose contents were changed after export", () => {
    const k = key();
    const { bytes } = packVolt(header(k), bundle(), k);
    const raw = unzipSync(bytes);
    const comments = JSON.parse(strFromU8(raw["comments.json"]));
    comments[0].author.name = "Asha Approver";
    raw["comments.json"] = strToU8(JSON.stringify(comments));
    expect(() => readVolt(zipSync(raw))).toThrow(/changed or damaged/);
  });

  it("detects a re-hashed manifest: the seal no longer verifies", () => {
    const k = key();
    const { bytes } = packVolt(header(k), bundle(), k);
    const raw = unzipSync(bytes);
    const comments = JSON.parse(strFromU8(raw["comments.json"]));
    comments[0].body = "Approved — no findings";
    raw["comments.json"] = strToU8(JSON.stringify(comments));
    const manifest = JSON.parse(strFromU8(raw["manifest.json"]));
    manifest.entries["comments.json"] = { sha256: createHash("sha256").update(raw["comments.json"]).digest("hex"), size: raw["comments.json"].byteLength };
    raw["manifest.json"] = strToU8(JSON.stringify(manifest));
    const r = readVolt(zipSync(raw));
    expect(r.check.intact).toBe(true);
    expect(r.check.sealValid).toBe(false);
    expect(r.check.publicKey).toBeNull();
  });

  it("a seal by another key than the one the manifest names does not verify", () => {
    const a = key();
    const b = key();
    const { bytes } = packVolt(header(a), bundle(), b);
    const r = readVolt(bytes);
    expect(r.check.sealValid).toBe(false);
    expect(r.check.problems.join(" ")).toMatch(/different server/);
  });

  it("reads an unsealed file as unverified", () => {
    const k = key();
    const raw = unzipSync(packVolt(header(k), bundle(), k).bytes);
    delete raw["seal.json"];
    const r = readVolt(zipSync(raw));
    expect(r.check).toMatchObject({ sealed: false, sealValid: false });
  });

  it("leaves out what the export options switch off", () => {
    const k = key();
    const h = { ...header(k), includes: { reviews: false, history: false, files: false } };
    const raw = unzipSync(packVolt(h, bundle(), k).bytes);
    expect(Object.keys(raw).filter((p) => /comments|files|signatures|reviews/.test(p))).toEqual([]);
    const r = readVolt(packVolt(h, bundle(), k).bytes);
    expect(r.bundle.comments).toEqual([]);
    expect(r.manifest.counts.comments).toBe(0);
  });

  it("rejects things that are not .volt files", () => {
    expect(() => readVolt(strToU8("<project/>"))).toThrow(VoltError);
    expect(() => readVolt(zipSync({ "a.txt": strToU8("x") }))).toThrow(/not a .volt file/);
    const k = key();
    const raw = unzipSync(packVolt(header(k), bundle(), k).bytes);
    const m = JSON.parse(strFromU8(raw["manifest.json"]));
    m.formatVersion = 99;
    raw["manifest.json"] = strToU8(JSON.stringify(m));
    expect(() => readVolt(zipSync(raw))).toThrow(/newer Volt/);
  });

  it("refuses broken drawings", () => {
    const k = key();
    const raw = unzipSync(packVolt(header(k), bundle(), k).bytes);
    raw["drawings/v1.json"] = strToU8(JSON.stringify({ schema: 1, meta: { title: "x" }, pages: [], defs: {} }));
    const m = JSON.parse(strFromU8(raw["manifest.json"]));
    m.entries["drawings/v1.json"] = { sha256: createHash("sha256").update(raw["drawings/v1.json"]).digest("hex"), size: raw["drawings/v1.json"].byteLength };
    raw["manifest.json"] = strToU8(JSON.stringify(m));
    expect(() => readVolt(zipSync(raw))).toThrow(/not a Volt drawing/);
  });

  it("stops a zip bomb before inflating it", () => {
    const k = key();
    const raw = unzipSync(packVolt(header(k), bundle(), k).bytes);
    raw["history/huge.json"] = new Uint8Array(90 * 1024 * 1024);
    const z = zipSync(raw, { level: 9 });
    expect(z.byteLength).toBeLessThan(1024 * 1024);
    expect(() => readVolt(z)).toThrow(/larger than/);
  });

  it("keeps the newest working version of each line editable, the rest become records", () => {
    const vs = [
      version({ id: "a", seq: 1, status: "RELEASED" }),
      version({ id: "b", seq: 2, status: "DRAFT" }),
      version({ id: "c", seq: 3, status: "APPROVED", variantId: "x" }),
      version({ id: "d", seq: 4, status: "CHANGES_REQUESTED", variantId: "y" }),
      // a draft that was itself an imported record elsewhere stays a record
      version({ id: "e", seq: 5, status: "DRAFT", variantId: "z", statusFrom: "Other Volt" }),
    ];
    expect(Object.fromEntries(importStatuses(vs))).toEqual({ a: "IMPORTED", b: "DRAFT", c: "IMPORTED", d: "DRAFT", e: "IMPORTED" });
  });

  it("names a record by all the servers it has been on", () => {
    expect(keysOf({ id: "v9", lineage: ["ed25519:aaa/v3"] }, "ed25519:bbb")).toEqual(["ed25519:aaa/v3", "ed25519:bbb/v9"]);
  });
});
