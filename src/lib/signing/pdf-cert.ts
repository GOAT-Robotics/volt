import "server-only";
import forge from "node-forge";
import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ascii } from "./pdf-cert-names";

/**
 * The X.509 certificate that digitally signs release PDFs (PAdES, see release-signed.ts).
 *
 * Where it comes from, first match:
 * 1. PDF_SIGNING_P12 (base64 PKCS#12) + PDF_SIGNING_P12_PASSWORD — e.g. from a secret store;
 * 2. ${DATA_DIR}/pdf-signing.p12 + .pass — uploaded by an admin, or
 * 3. generated on first use: a self-signed RSA-3072 certificate for the organization (10 years).
 *    PDF readers show the file as signed and unchanged; the signer's identity shows as unverified
 *    until the certificate is trusted (IT adds it, or an admin uploads a CA-issued certificate).
 *
 * Only RSA keys: the PDF signing library (node-forge) signs with RSA.
 */

export type PdfCertInfo = {
  subject: string;
  issuer: string;
  /** SHA-256 of the certificate (colon-separated hex, as PDF readers show it) */
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  selfSigned: boolean;
  source: "environment" | "uploaded" | "generated";
  /** the certificate (public part) to hand to IT / add to a trust list */
  certPem: string;
};
export type PdfCert = PdfCertInfo & { p12: Buffer; passphrase: string };

const dataDir = () => process.env.DATA_DIR || path.join(process.cwd(), "data");
const files = () => {
  const d = dataDir();
  return { p12: path.join(d, "pdf-signing.p12"), pass: path.join(d, "pdf-signing.pass"), meta: path.join(d, "pdf-signing.json") };
};

let cached: PdfCert | null = null;

const bin = (b: Buffer) => forge.util.createBuffer(b.toString("binary"));

/**
 * The signature names its signer by the certificate's issuer and serial number, re-encoded by
 * node-forge. Non-ASCII names come out differently from the certificate (PDF readers then cannot
 * find the signer), so such certificates are refused.
 */
function issuerReencodes(cert: forge.pki.Certificate): boolean {
  const tbs = (cert as unknown as { tbsCertificate?: forge.asn1.Asn1 }).tbsCertificate;
  if (!tbs) return true;
  const fields = tbs.value as forge.asn1.Asn1[];
  const off = fields[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return forge.asn1.toDer(fields[off + 2]).getBytes() === forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
}

/** Opens a PKCS#12 file: its RSA private key and the certificate that belongs to it. */
export function openP12(p12: Buffer, passphrase: string): { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate } {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin(p12)), false, passphrase);
  } catch {
    throw new Error("Could not open the certificate — wrong password, or not a PKCS#12 (.p12 / .pfx) file");
  }
  const bags = (type: string) => parsed.getBags({ bagType: type })[type] ?? [];
  const key = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].map((b) => b.key).find(Boolean) as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error("The file has no private key");
  if (!key.n || !key.e) throw new Error("Only RSA certificates can sign PDFs here");
  const pubPem = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(key.n, key.e));
  const cert = bags(forge.pki.oids.certBag)
    .map((b) => b.cert)
    .find((c): c is forge.pki.Certificate => !!c && forge.pki.publicKeyToPem(c.publicKey) === pubPem);
  if (!cert) throw new Error("The file has no certificate for its private key");
  if (!issuerReencodes(cert)) throw new Error("This certificate's issuer name has non-ASCII characters, which the PDF signer cannot reproduce exactly — use a certificate with a plain ASCII issuer name");
  return { key, cert };
}

function describe(p12: Buffer, passphrase: string, source: PdfCertInfo["source"]): PdfCert {
  const { cert } = openP12(p12, passphrase);
  const certPem = forge.pki.certificateToPem(cert);
  const x = new X509Certificate(certPem);
  return {
    p12,
    passphrase,
    source,
    subject: x.subject.replace(/\n/g, ", "),
    issuer: x.issuer.replace(/\n/g, ", "),
    fingerprint: x.fingerprint256,
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    selfSigned: x.subject === x.issuer,
    certPem,
  };
}

/** A self-signed document-signing certificate for the organization, as PKCS#12. */
export function generateP12(orgName: string): { p12: Buffer; passphrase: string } {
  const org = (ascii(orgName) || "Volt").slice(0, 60);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }).toString()) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = "01" + randomBytes(15).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
  cert.validity.notAfter = new Date(cert.validity.notBefore.getTime() + 10 * 365.25 * 86400_000);
  const utf8 = forge.asn1.Type.UTF8;
  const attrs = [
    // ASCII only: see issuerReencodes
    { name: "commonName", value: `${org} document signing`, valueTagClass: utf8 },
    { name: "organizationName", value: org, valueTagClass: utf8 },
    { shortName: "OU", value: "Volt releases", valueTagClass: utf8 },
  ] as unknown as forge.pki.CertificateField[];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
    // PDF readers accept e-mail protection (or no EKU) for document signatures
    { name: "extKeyUsage", emailProtection: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const passphrase = randomBytes(24).toString("base64url");
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, { algorithm: "aes256", friendlyName: `${org} document signing` });
  return { p12: Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary"), passphrase };
}

function writeSecret(file: string, data: Buffer | string, exclusive: boolean) {
  if (exclusive) {
    writeFileSync(file, data, { mode: 0o600, flag: "wx" });
  } else {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  }
  chmodSync(file, 0o600);
}

/** The signing certificate (see the top of this file); generated for `orgName` on first use. */
export function loadPdfCert(orgName = ""): PdfCert {
  if (cached) return cached;
  if (process.env.PDF_SIGNING_P12) {
    cached = describe(Buffer.from(process.env.PDF_SIGNING_P12, "base64"), process.env.PDF_SIGNING_P12_PASSWORD ?? "", "environment");
    return cached;
  }
  const f = files();
  if (!existsSync(f.p12)) {
    mkdirSync(dataDir(), { recursive: true });
    const g = generateP12(orgName);
    try {
      writeSecret(f.pass, g.passphrase, true);
      writeSecret(f.p12, g.p12, true);
      writeFileSync(f.meta, JSON.stringify({ source: "generated", at: new Date().toISOString() }));
    } catch (e) {
      // another process created it at the same time — use theirs
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  let source: PdfCertInfo["source"] = "generated";
  try {
    source = JSON.parse(readFileSync(f.meta, "utf8")).source === "uploaded" ? "uploaded" : "generated";
  } catch {}
  cached = describe(readFileSync(f.p12), existsSync(f.pass) ? readFileSync(f.pass, "utf8").trim() : "", source);
  return cached;
}

/** Replaces the signing certificate with an uploaded PKCS#12 (checked first). */
export function saveUploadedP12(p12: Buffer, passphrase: string): PdfCertInfo {
  if (process.env.PDF_SIGNING_P12) throw new Error("The certificate is set by the PDF_SIGNING_P12 environment variable — change it there");
  const info = describe(p12, passphrase, "uploaded");
  if (new Date(info.notAfter) < new Date()) throw new Error(`This certificate expired on ${info.notAfter.slice(0, 10)}`);
  const f = files();
  mkdirSync(dataDir(), { recursive: true });
  writeSecret(f.pass, passphrase, false);
  writeSecret(f.p12, p12, false);
  writeFileSync(f.meta, JSON.stringify({ source: "uploaded", at: new Date().toISOString() }));
  cached = info;
  return publicInfo(info);
}

export const publicInfo = ({ p12: _p, passphrase: _s, ...info }: PdfCert): PdfCertInfo => info;
