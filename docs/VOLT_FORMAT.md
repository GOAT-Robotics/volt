# The .volt file

A `.volt` file holds a Volt project — or one version of it — together with its reviews, in one
file that can be downloaded, sent to someone, and uploaded into any Volt server. It is how a
drawing goes out for review to a customer or supplier who runs their own Volt, and how their
review comes back.

Code: `src/lib/voltfile/` (`format.ts` reads and writes the archive, `export.ts` builds it from the
database, `import.ts` imports and merges, `types.ts` holds the shared shapes). Tests:
`src/lib/voltfile/__tests__/format.test.ts`.

## What you can do with it

| Where | What |
|---|---|
| Project page → **Share → Download project as .volt** | The whole project: every version and variant, drawings, commit history, comments, review rounds, signature records, attachments and component datasheets. |
| Version row **⋯ → Share for review (.volt)**, or the editor's **Export → .volt** | One version with its comments and review, to send to a reviewer. |
| Projects → **Import** (or project page → **Share → Merge reviews from a .volt file**) | Volt checks the file and offers what fits: **Import as a new project**, or — when the file is a reviewed copy of one of your versions — **Merge reviews back**. |

Each export can leave out comments and reviews, commit history (project files) and attachments.
Exports, imports and merges are in the audit trail (`project.export` with `format: "volt"`,
`project.import`, `volt.merge`), and the uploaded file is kept unchanged with its SHA-256 under
the project's Attachments → Imported source files.

### Round trip with a reviewer

1. You: version row ⋯ → **Share for review (.volt)** → send the file.
2. Reviewer: Projects → Import → **Import as a new project**. A version that was in review (or
   approved, released …) comes in as a read-only **Imported** record they can comment on; a
   working draft stays a draft they can edit and put through their own review.
3. Reviewer: comments on the drawing, replies to your questions, and exports their copy
   (⋯ → Share for review) back to you.
4. You: Projects → Import (or Share → Merge reviews from a .volt file) → **Merge reviews back**.
   New comment threads, replies and attachments land on your version, with the reviewer's name
   and email and a badge naming their server; review decisions they made become comments.
   Merging the same file again adds nothing.

Open merged comments count like any other: with "open comments block approval", they must be
resolved before the version can be approved.

## Trust

A file proves only what its seal proves.

- **Integrity.** `manifest.json` lists the SHA-256 and size of every other entry. A file whose
  entries do not match is refused ("changed or damaged after it was exported").
- **Seal.** `seal.json` is an Ed25519 signature of the exporting server over the manifest, made
  with the server's built-in signing key (the same key that seals signatures, `docs/SIGNING.md`).
  The importer shows one of: *sealed by this server*, *sealed by &lt;server&gt;* (key id shown),
  *not sealed*, *seal does not verify*.
- **People.** Only when this server sealed the file are the people in it matched to accounts
  here. Otherwise every comment, commit and review keeps the name and email the file gives, and is
  stored as imported by the person who uploaded the file. Imported comments cannot be edited.
- **Approvals and signatures never transfer.** Versions that were not working drafts become
  `IMPORTED` (read-only, not submittable, signable or releasable; start a new version to change
  them). Imported review rounds have status `IMPORTED` and are never evaluated or shown in
  anyone's review inbox. Signature records are shown on the Signatures tab as records — their
  evidence seal is checked against the key that sealed the file when the evidence is included —
  and never become signatures here: a release needs a signature on this server.
- **Merging back** adds comments only. Status changes on existing threads and changes to the
  drawing are not merged (the dialog warns when the drawing differs). Findings of the other
  server's AI reviewer are left out unless someone answered them there.
- **Privacy.** A file with reviews names the people who commented, reviewed and signed (name and
  email). Signature evidence (sign-in time, IP address, browser) is included only when the person
  exporting manages the project. Library datasheets stay in the library.

## Archive layout (format version 1)

A ZIP archive (deflate). Entries:

| Entry | Content |
|---|---|
| `mimetype` | `application/vnd.volt+zip`, first entry, stored uncompressed (like ODF/EPUB, so the type can be sniffed from byte 30) |
| `manifest.json` | the manifest (below), canonical JSON (sorted keys) |
| `seal.json` | `{ alg: "Ed25519", keyId, publicKey (SPKI PEM), signature (base64 over manifest.json) }` |
| `README.txt` | a note for people who open the archive by hand |
| `project.json` | `{ project, variants }` |
| `versions.json` | version records |
| `drawings/<versionId>.json` | the drawing of each version (the Volt document, `src/core/model.ts` `Doc`, including the original .qet source when there is one) |
| `commits.json`, `history/<commitId>.json` | commit records and their drawings (whole-project files) |
| `comments.json`, `reviews.json`, `signatures.json` | review records |
| `files.json`, `files/<id>/<name>` | attachments and component documents with their bytes (link-only documents have no entry) |

`keyId` is `"ed25519:"` + the first 32 hex digits of the SHA-256 of the public key (DER).

### Manifest

```jsonc
{
  "format": "volt",
  "formatVersion": 1,
  "scope": "project",            // or "version"
  "createdAt": "2026-10-20T08:00:00.000Z",
  "generator": "Volt",
  "server": { "keyId": "ed25519:…", "name": "GOAT Robotics", "url": "https://volt.example.com" },
  "exportedBy": { "id": "…", "name": "…", "email": "…" },
  "project": { "id": "…", "name": "…", "number": "…" },
  "versions": [{ "id": "…", "label": "2", "status": "IN_REVIEW", "variant": null, "docHash": "…" }],
  "includes": { "reviews": true, "history": true, "files": true },
  "counts": { "versions": 2, "commits": 14, "comments": 9, "reviews": 1, "signatures": 0, "files": 3 },
  "entries": { "project.json": { "sha256": "…", "size": 812 }, "…": {} }
}
```

### Records

Records keep their ids from the exporting server. People are `{ id, name, email?, bot? }` (`id` is
empty for people who are not accounts on the exporting server). Dates are ISO strings or null.
The zod schemas in `format.ts` are the reference; readers ignore unknown fields.

- **Version**: `id, seq, label, status, statusFrom, variantId, parentId, summary, description,
  ticket, createdBy, createdAt, submittedAt, approvedAt, signedAt, releasedAt, endedAt, endReason,
  docHash, headCommitId, baseCommitId, lineage`. `status` is the status where the version was made;
  `statusFrom` names that server when it is not the exporting one.
- **Comment**: `id, versionId, pageId, anchor ({ type: element|wire|text|region|point, id?, x, y,
  w?, h? }), parentId, body, status, author, createdAt, updatedAt, lineage, from`.
- **Review**: `id, versionId, status, instructions, dueDate, sequential, submittedBy, createdAt,
  closedAt, commitId, lineage, from, assignments: [{ id, order, who, group, canApprove, decision,
  reason, decidedBy, decidedAt }]`.
- **Signature**: `id, versionId, signatory, purpose, order, status, docHash, pdfHash, provider,
  signedAt, declineReason, createdAt, evidence, seal, importedFrom`.
- **Commit**: `id, versionId, parentId, seq, kind, message, docHash, author, createdAt`.
- **File**: `id, kind (attachment|document), path, filename, mime, size, sha256, createdAt,
  uploadedBy`, plus `ownerType, ownerId` (attachments: PROJECT, RELEASE, COMMENT, REVIEW) or
  `docKind, title, url, elementId, manufacturer, partNumber` (component documents).

### Lineage

A record that has been on other servers lists the keys it had there, oldest first:
`"<server keyId>/<record id>"`. Its key on the exporting server is `"<manifest.server.keyId>/<id>"`.
On import, these keys are stored with the record (`Version.imported.keys`, `Comment.origin`,
`Review.imported.keys`) and written back on the next export. When a file comes back, a version in
it whose keys include `"<this server's keyId>/<versionId>"` is a copy of that version: the merge
target. A comment whose keys match a comment already on the target is not added again. Review
decisions are keyed `"<review key>:<assignment id>"`.

### Limits

Upload 100 MB; unpacked 600 MB in total, 80 MB per entry, 20 000 entries (checked before
inflating). Attachments over 25 MB or of a type Volt does not accept (`src/lib/uploads.ts`) are not
imported, and the import report says so.

### Versions of the format

`formatVersion` is raised only for changes older readers cannot ignore. A server refuses files
with a newer format version ("made by a newer Volt — update Volt to open it").
