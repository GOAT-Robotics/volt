import { PDFDocument } from "pdf-lib";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { ascii } from "./pdf-cert-names";

/**
 * Digitally signs a PDF: adds an (invisible) signature field and a CMS signature (PAdES-style
 * adbe.pkcs7.detached, SHA-256) over the file's byte range, with the key and certificate of a PKCS#12.
 */
export async function signPdf(bytes: Uint8Array, cert: { p12: Buffer; passphrase: string }, info: { reason: string; name: string; location: string; contactInfo: string }): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  // the signature dictionary stores plain PDF strings: keep them ASCII
  pdflibAddPlaceholder({ pdfDoc, reason: ascii(info.reason), name: ascii(info.name), location: ascii(info.location), contactInfo: ascii(info.contactInfo), signatureLength: 16384, appName: "Volt" });
  const prepared = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return signpdf.sign(prepared, new P12Signer(cert.p12, { passphrase: cert.passphrase }));
}
