import { describe, expect, it } from "vitest";
import forge from "node-forge";
import { createHash, X509Certificate } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { generateP12, openP12 } from "../pdf-cert";
import { checkPdfSignature, COPY_CODE, signPdf } from "../pdf-sign";

/** The signed byte ranges and the CMS blob of a signed PDF. */
function parseSignature(pdf: Buffer) {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no ByteRange");
  const [a, b, c, d] = m.slice(1).map(Number);
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  const hex = pdf.subarray(a + b + 1, c - 1).toString("latin1").replace(/0+$/, "");
  return { range: [a, b, c, d], signed, cms: Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex") };
}

describe("release PDF signing", () => {
  // a non-ASCII organization name must still give a signature whose signer can be found
  const { p12, passphrase } = generateP12("GOAT Robotics — Coimbatore");

  it("generates a self-signed document-signing certificate for the organization", () => {
    const { cert } = openP12(p12, passphrase);
    const x = new X509Certificate(forge.pki.certificateToPem(cert));
    expect(x.subject).toContain("O=GOAT Robotics - Coimbatore");
    expect(x.subject).toBe(x.issuer);
    expect(x.checkPrivateKey).toBeDefined();
    expect(new Date(x.validTo).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 9);
    expect(() => openP12(p12, "wrong")).toThrow(/wrong password/);
  });

  it("signs a PDF so that the signature covers the whole file except the signature itself", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("Cobot Stand v1");
    const signed = await signPdf(await doc.save(), { p12, passphrase }, { reason: "Released drawing Demo — ATS panel v1", name: "GOAT Robotics", location: "Coimbatore", contactInfo: "https://volt.example.com" });
    expect(signed.toString("latin1")).toContain("/Reason (Released drawing Demo - ATS panel v1)");
    const { range, signed: content, cms } = parseSignature(signed);
    expect(range[0]).toBe(0);
    expect(range[2] + range[3]).toBe(signed.length);

    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(cms.toString("binary")))) as forge.pkcs7.PkcsSignedData & { rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string } };
    // messageDigest attribute = SHA-256 of the signed byte ranges
    const attrs = msg.rawCapture.authenticatedAttributes;
    const digestAttr = attrs.find((a) => forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0].value as string) === forge.pki.oids.messageDigest)!;
    const digest = Buffer.from((((digestAttr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string), "binary").toString("hex");
    expect(digest).toBe(createHash("sha256").update(content).digest("hex"));

    // the RSA signature over the authenticated attributes verifies with the certificate's key
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const md = forge.md.sha256.create().update(forge.asn1.toDer(set).getBytes());
    const pub = msg.certificates[0].publicKey as forge.pki.rsa.PublicKey;
    expect(pub.verify(md.digest().getBytes(), msg.rawCapture.signature)).toBe(true);

    // the SignerInfo names exactly the embedded certificate (issuer DER + serial), so readers find the signer
    const sd = forge.asn1.fromDer(forge.util.createBuffer(cms.toString("binary")));
    const signedData = ((sd.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    const signerInfo = (signedData[signedData.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    const [sidIssuer, sidSerial] = signerInfo[1].value as forge.asn1.Asn1[];
    const certTbs = (msg.certificates[0] as unknown as { tbsCertificate: forge.asn1.Asn1 }).tbsCertificate.value as forge.asn1.Asn1[];
    expect(forge.asn1.toDer(sidIssuer).toHex()).toBe(forge.asn1.toDer(certTbs[3]).toHex());
    expect(forge.util.bytesToHex(sidSerial.value as string)).toBe(forge.util.bytesToHex(certTbs[1].value as string));

    // tampering with a signed byte changes the digest
    const tampered = Buffer.from(signed);
    tampered[range[1] + range[2] - range[1] + 10] ^= 1;
    expect(createHash("sha256").update(parseSignature(tampered).signed).digest("hex")).not.toBe(digest);
  });

  it("stamps every page of a copy, puts the copy code in the file and the checker verifies it", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([1190.55, 841.89]);
    doc.addPage([1190.55, 841.89]);
    doc.addPage([595.28, 841.89]);
    const signed = await signPdf(await doc.save(), { p12, passphrase }, { reason: "Released drawing Cobot Stand v1 - copy VLT-7KQ2-9XHM", name: "GOAT Robotics", location: "Coimbatore", contactInfo: "" }, {
      stamp: { project: "Cobot Stand", label: "1", released: "3 Nov 2026", approvers: ["Asha Approver", "Riya Reviewer"], copy: { code: "VLT-7KQ2-9XHM", by: "Naveen Sakthivel", at: "2026-11-03 07:35 UTC" } },
    });
    const back = await PDFDocument.load(signed);
    expect(back.getPageCount()).toBe(3);
    // every page got the stamp's content stream on top of its own
    for (const page of back.getPages()) expect(page.node.Contents()).toBeDefined();
    expect(back.getKeywords()).toContain("volt-copy:VLT-7KQ2-9XHM");
    expect(signed.toString("latin1").match(COPY_CODE)?.[0]).toBe("VLT-7KQ2-9XHM");

    const ok = checkPdfSignature(signed);
    expect(ok).toMatchObject({ present: true, intact: true, valid: true, coversWholeFile: true });
    expect(ok.signer).toContain("GOAT Robotics");
    expect(ok.certFingerprint).toBe(new X509Certificate(forge.pki.certificateToPem(openP12(p12, passphrase).cert)).fingerprint256);

    // one changed byte in the signed range: not intact any more
    const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(signed.toString("latin1"))!.slice(1).map(Number);
    const tampered = Buffer.from(signed);
    tampered[range[2] + 50] ^= 1;
    expect(checkPdfSignature(tampered)).toMatchObject({ present: true, intact: false });
    expect(checkPdfSignature(Buffer.from("%PDF-1.7 no signature"))).toMatchObject({ present: false });
  });
});
