# Electronic signatures in Volt

Volt ships a **provider-neutral** signature layer (`src/lib/signing/provider.ts`) and a **built-in provider**
(`src/lib/signing/builtin.ts`) that produces tamper-evident, application-level signature records.

## What is signed

A signature always refers to an **immutable** version (status `APPROVED` when requested). Two hashes are fixed
when signatures are requested and re-computed by the server at signing and verification time:

| Hash | How it is computed |
|---|---|
| `docHash` | SHA-256 of `stableStringify(doc)` — the stored drawing JSON with sorted keys (`versioning.docHash`). |
| `pdfHash` | SHA-256 of the **canonical PDF**: `exportPdf(doc, { pages: all non-archived pages, paper: "A3", deterministic: true, version: label })`. Deterministic mode fixes creation/modification dates and disables object streams, so the same document always yields byte-identical output. Signatories can open this exact PDF from the sign page (`GET /api/versions/{id}/canonical.pdf`). |

If either hash no longer matches, signing is refused and verification fails.

## The signing ceremony (built-in provider)

1. A project owner requests signatures (`POST /api/versions/{id}/signatures`) from users with the **Signatory**
   or **Admin** role. Requests carry a purpose, an order (signing is sequential) and an expiry
   (`settings.signature.expiryDays`). Signatories are notified.
2. The signatory opens `/sign/{signatureId}`: project, version, purpose, both hashes, a link to the canonical PDF
   and the workspace **signature statement**.
3. **Recent authentication** is required: the session's `authTime` must be newer than
   `settings.signReauthMinutes`. Otherwise the page offers *Re-authenticate to sign* — with Microsoft Entra ID this
   starts a new authorization request with `prompt=login` (forcing credential entry/MFA per your Conditional
   Access policies); with the development provider it signs out and back in.
4. The signatory types their full name (must match the account name) and accepts the statement.
5. The server re-computes `docHash` and `pdfHash` from the stored immutable document, builds the **evidence**:

   ```json
   {
     "signatory": { "id", "name", "email", "entraOid" },
     "authTime", "signedAt", "ip", "userAgent",
     "versionId", "label", "projectId",
     "docHash", "pdfHash", "purpose", "statement",
     "provider": "builtin", "keyId": "ed25519:<fingerprint>"
   }
   ```

   and **seals** it: `seal = base64(Ed25519.sign(privateKey, stableStringify(evidence)))`.
6. When every signature of the request round is `SIGNED`, the version becomes `SIGNED` (and can be released when
   `approval.signatureRequiredForRelease` is on). A signatory may **decline** with a reason; the rest of that round
   is cancelled and the requester is notified. Everything is written to the audit log.

## Keys

The built-in provider uses one Ed25519 key per installation:

- `SIGNING_PRIVATE_KEY` / `SIGNING_PUBLIC_KEY` (PEM; `\n` escapes allowed) — recommended for production, e.g. from
  a secret store. The public key must match the private key.
- Otherwise a key is generated on first use and stored at `${DATA_DIR:-./data}/signing-key.pem` with mode `0600`.
  **Back it up** together with the database: without it, existing seals cannot be verified.

The key fingerprint (`keyId`, SHA-256 of the SPKI DER) is embedded in every evidence record and printed, with the
public key, in the release PDF. Rotating the key makes older seals report "sealed with a different key"; keep
the old public key to verify historic records offline.

## Verification

`GET /api/signatures/{id}/verify` → `{ valid, checks: [...] }` with checks for: signed status, seal validity,
evidence binding (evidence ↔ signature record), document hash, canonical PDF hash and version immutability.
The project *Signatures* tab has a **Verify** button and an evidence viewer.

Offline verification: take the evidence JSON, serialize it with sorted keys and no whitespace
(`stableStringify`), and verify the base64 seal with the public key printed in the release PDF
(e.g. `openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in evidence.json -sigfile seal.bin`).

## Release PDF

`GET /api/versions/{id}/release.pdf` (versions that are APPROVED, SIGNED, RELEASED or SUPERSEDED) returns the
canonical drawing pages followed by an **"Approval & signature record"**: version metadata and both hashes, every
review with each assignee's decision, name, date and reason, each signature's evidence and seal, the public-key
fingerprint and the verification URL.

## Legal status — read this

Signing in with Microsoft Entra ID **is not, by itself, a qualified or advanced electronic signature** and Volt
does not assert that it is. The built-in provider creates an *application-level electronic signature record*:
strong evidence of who approved what and when (authenticated identity, recent re-authentication, explicit
statement, document hashes, server seal, audit trail). Whether that satisfies a particular regulation (eIDAS
QES/AdES, 21 CFR Part 11, customer contracts, …) depends on your jurisdiction, your identity-provider controls
(MFA, Conditional Access), your procedures and validation. Where a qualified or advanced signature is required,
use an external trust-service provider through the provider interface.

## Plugging in DocuSign, Adobe Acrobat Sign or another provider

Implement `SigningProvider` and register it:

```ts
// src/lib/signing/docusign.ts
import type { SigningProvider } from "./provider";

export const docusignProvider: SigningProvider = {
  id: "docusign",
  label: "DocuSign",
  async request(i) {
    // create an envelope with the canonical PDF (GET /api/versions/{versionId}/canonical.pdf bytes),
    // recipient = i.signatory (routing order from Volt's order), embedded signing return URL = i.returnUrl
    return { providerRef: envelopeId, redirectUrl: recipientViewUrl };
  },
  async complete({ providerRef, evidence }) {
    // called after the provider reports completion (webhook / return URL): download the completed document or
    // certificate of completion, check that the signed PDF's hash corresponds to evidence.pdfHash,
    // and return the provider's proof (e.g. base64 of the signed PDF's CMS signature or the envelope certificate)
    return { seal: proofBase64, providerRef };
  },
  async verify({ evidence, seal, providerRef }) {
    // validate the proof (certificate chain / provider API) and that it covers evidence.pdfHash
    return { valid: true, detail: "Envelope completed and certificate chain valid" };
  },
  async publicInfo() {
    return { keyId: "docusign", algorithm: "PAdES (provider)" };
  },
};

// src/lib/signing/provider.ts
registerProvider("docusign", async () => (await import("./docusign")).docusignProvider);
```

Then set the workspace setting `signature.provider` to the new id (extend the enum in
`src/lib/settings.ts` and the admin settings schema). Volt keeps the rest of the workflow unchanged: approval
gating, sequential order, hash re-computation, the `SIGNED` transition, audit, notifications and the release PDF
(which prints the provider id and proof). For Adobe Acrobat Sign the same mapping applies (agreement =
envelope; `providerRef` = agreement id).
