/**
 * Provider-neutral electronic signature interface.
 *
 * A provider receives a signature *request* (after a version is APPROVED), *completes* it once the
 * signatory has confirmed (built-in: an in-app ceremony; external providers: a webhook/redirect
 * return), and can *verify* stored evidence later. See docs/SIGNING.md.
 */

export type SignatoryInfo = { id: string; name: string; email: string; entraOid: string | null };

export type SignatureEvidence = {
  signatory: SignatoryInfo;
  /** epoch ms of the (re-)authentication used for this signature */
  authTime: number;
  signedAt: string;
  ip: string | null;
  userAgent: string;
  versionId: string;
  label: string;
  projectId: string;
  docHash: string;
  pdfHash: string;
  purpose: string;
  statement: string;
  provider: string;
  /** fingerprint of the key that produced the seal (built-in provider) */
  keyId?: string;
};

export type SignRequestInput = {
  signatureId: string;
  signatory: SignatoryInfo;
  projectName: string;
  label: string;
  purpose: string;
  docHash: string;
  pdfHash: string;
  expiresAt: Date | null;
  /** absolute URL where the signatory completes the ceremony */
  returnUrl: string;
};

export type SignRequestResult = {
  /** provider-side envelope / transaction id */
  providerRef?: string;
  /** where to send the signatory (external providers); the built-in provider uses the in-app sign page */
  redirectUrl?: string;
};

export type VerifyResult = { valid: boolean; detail: string; keyId?: string };

export interface SigningProvider {
  readonly id: string;
  readonly label: string;
  request(input: SignRequestInput): Promise<SignRequestResult>;
  /** Produce the provider's seal over the canonical evidence (or fetch it from the external provider). */
  complete(input: { signatureId: string; providerRef?: string | null; evidence: SignatureEvidence }): Promise<{ seal: string; providerRef?: string }>;
  verify(input: { evidence: SignatureEvidence; seal: string; providerRef?: string | null }): Promise<VerifyResult>;
  /** Public verification material for the release record, if any. */
  publicInfo(): Promise<{ keyId: string; algorithm: string; publicKeyPem?: string } | null>;
}

const registry = new Map<string, () => Promise<SigningProvider>>();

export function registerProvider(id: string, load: () => Promise<SigningProvider>) {
  registry.set(id, load);
}

registerProvider("builtin", async () => (await import("./builtin")).builtinProvider);

export async function getProvider(id: string = "builtin"): Promise<SigningProvider> {
  const load = registry.get(id);
  if (!load) throw new Error(`Unknown signing provider: ${id}`);
  return load();
}
