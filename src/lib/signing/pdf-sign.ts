import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import forge from "node-forge";
import { createHash } from "node:crypto";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { ascii } from "./pdf-cert-names";

/** What the release stamp in the corner of every page says. */
export type ReleaseStamp = {
  project: string;
  label: string;
  /** e.g. "3 Nov 2026" */
  released: string;
  approvers: string[];
  /** this downloaded copy: printed on every page, so a print that turns up later can be traced */
  copy?: { code: string; by: string; at: string };
};

/** copy codes: VLT-XXXX-XXXX (Crockford base32, no I L O U) */
export const COPY_CODE = /VLT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/;

const GREEN = rgb(0.05, 0.52, 0.26);
const INK = rgb(0.15, 0.16, 0.18);
const GREY = rgb(0.38, 0.39, 0.42);

/** text the standard fonts can draw (WinAnsi); anything else becomes "?" */
function winAnsi(font: PDFFont, s: string) {
  let out = "";
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}
function fit(font: PDFFont, s: string, size: number, max: number) {
  let t = winAnsi(font, s);
  if (font.widthOfTextAtSize(t, size) <= max) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/**
 * Stamps every page in its top-right corner (the sheet margin): a green tick, APPROVED & RELEASED,
 * project, version, release date and approvers — and, for a downloaded copy, its code, who
 * downloaded it and when. Any single printed page shows that it is the approved release.
 */
export async function stampPages(pdfDoc: PDFDocument, s: ReleaseStamp) {
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  pages.forEach((page, i) => drawStamp(page, s, i, pages.length, bold, reg));
}

function drawStamp(page: PDFPage, s: ReleaseStamp, i: number, n: number, bold: PDFFont, reg: PDFFont) {
  const { width, height } = page.getSize();
  const left = [
    { t: fit(bold, "APPROVED & RELEASED", 8.5, 240), f: bold, size: 8.5, color: GREEN },
    { t: fit(reg, `${s.project} · v${s.label} · released ${s.released}`, 6, 240), f: reg, size: 6, color: INK },
    { t: fit(reg, s.approvers.length ? `Approved & signed by ${s.approvers.join(", ")}` : "Approval record on the last pages", 6, 240), f: reg, size: 6, color: INK },
  ];
  const right = s.copy
    ? [
        { t: fit(bold, `COPY ${s.copy.code}`, 7, 170), f: bold, size: 7, color: INK },
        { t: fit(reg, `Downloaded by ${s.copy.by}`, 6, 170), f: reg, size: 6, color: GREY },
        { t: fit(reg, `${s.copy.at} · page ${i + 1} of ${n}`, 6, 170), f: reg, size: 6, color: GREY },
      ]
    : [{ t: fit(reg, `page ${i + 1} of ${n}`, 6, 170), f: reg, size: 6, color: GREY }];
  const lw = Math.max(...left.map((l) => l.f.widthOfTextAtSize(l.t, l.size)));
  const rw = Math.max(...right.map((l) => l.f.widthOfTextAtSize(l.t, l.size)));
  const h = 31;
  const w = 26 + lw + 10 + rw + 8;
  const x = width - w - 14;
  const y = height - h - 3;
  page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1), opacity: 0.94, borderColor: GREEN, borderWidth: 0.9 });
  // the tick: a green disc with a white check mark (drawn, the standard fonts have no ✓)
  page.drawCircle({ x: x + 13, y: y + h / 2, size: 8.5, color: GREEN });
  page.drawSvgPath("M -4.2 0.2 L -1.3 3.2 L 4.4 -3.4", { x: x + 13, y: y + h / 2, borderColor: rgb(1, 1, 1), borderWidth: 1.7 });
  const base = [h - 10.5, h - 18.5, h - 25.5];
  left.forEach((l, k) => page.drawText(l.t, { x: x + 26, y: y + base[k], size: l.size, font: l.f, color: l.color }));
  const rx = x + 26 + lw + 10;
  page.drawLine({ start: { x: rx - 5, y: y + 4 }, end: { x: rx - 5, y: y + h - 4 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.84) });
  right.forEach((l, k) => page.drawText(l.t, { x: rx, y: y + base[k], size: l.size, font: l.f, color: l.color }));
}

/**
 * Digitally signs a PDF: optional release stamp on every page and copy code in the metadata, then
 * an (invisible) signature field and a CMS signature (PAdES-style adbe.pkcs7.detached, SHA-256)
 * over the file's byte range, with the key and certificate of a PKCS#12.
 */
export async function signPdf(
  bytes: Uint8Array,
  cert: { p12: Buffer; passphrase: string },
  info: { reason: string; name: string; location: string; contactInfo: string },
  opts: { stamp?: ReleaseStamp } = {},
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (opts.stamp) await stampPages(pdfDoc, opts.stamp);
  if (opts.stamp?.copy) {
    // machine-readable too: found again when the file is uploaded to Verify a PDF
    const kw = pdfDoc.getKeywords();
    pdfDoc.setKeywords([...(kw ? kw.split(/\s+/).filter(Boolean) : []), `volt-copy:${opts.stamp.copy.code}`]);
  }
  // the signature dictionary stores plain PDF strings: keep them ASCII
  pdflibAddPlaceholder({ pdfDoc, reason: ascii(info.reason), name: ascii(info.name), location: ascii(info.location), contactInfo: ascii(info.contactInfo), signatureLength: 16384, appName: "Volt" });
  const prepared = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return signpdf.sign(prepared, new P12Signer(cert.p12, { passphrase: cert.passphrase }));
}

export type PdfSignatureCheck = {
  /** a signature (ByteRange + CMS) was found */
  present: boolean;
  /** the signed bytes still hash to the digest in the signature, and it covers the whole file */
  intact: boolean;
  /** the RSA signature over the signed attributes verifies with the embedded certificate */
  valid: boolean;
  coversWholeFile: boolean;
  signer: string | null;
  /** SHA-256 of the signer certificate, colon-separated hex */
  certFingerprint: string | null;
  error?: string;
};

/** Checks the (last) digital signature of a PDF signed this way (RSA / SHA-256, adbe.pkcs7.detached). */
export function checkPdfSignature(pdf: Buffer): PdfSignatureCheck {
  const none: PdfSignatureCheck = { present: false, intact: false, valid: false, coversWholeFile: false, signer: null, certFingerprint: null };
  const text = pdf.toString("latin1");
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const m = all[all.length - 1];
  if (!m) return none;
  try {
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a !== 0 || a + b > pdf.length || c + d > pdf.length || c < a + b) return { ...none, present: true, error: "The signature byte range is broken" };
    const content = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
    // the placeholder is zero-padded: parse the DER by its own length and ignore the padding
    const hex = pdf.subarray(a + b, c).toString("latin1").replace(/[<>\s]/g, "");
    const der = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), { parseAllBytes: false } as unknown as boolean /* node-forge takes options; its types lag */)) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { authenticatedAttributes?: forge.asn1.Asn1[]; signature: string };
    };
    const attrs = msg.rawCapture.authenticatedAttributes ?? [];
    const digestAttr = attrs.find((x) => forge.asn1.derToOid((x.value as forge.asn1.Asn1[])[0].value as string) === forge.pki.oids.messageDigest);
    const digest = digestAttr ? Buffer.from(((digestAttr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string, "binary").toString("hex") : "";
    const intactBytes = !!digest && digest === createHash("sha256").update(content).digest("hex");
    const cert = msg.certificates[0];
    let valid = false;
    if (cert && attrs.length) {
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const md = forge.md.sha256.create().update(forge.asn1.toDer(set).getBytes());
      valid = (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), msg.rawCapture.signature);
    }
    const certDer = cert ? Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary") : null;
    const fp = certDer ? createHash("sha256").update(certDer).digest("hex").toUpperCase().match(/../g)!.join(":") : null;
    const coversWholeFile = c + d === pdf.length;
    return {
      present: true,
      intact: intactBytes && coversWholeFile,
      valid,
      coversWholeFile,
      signer: cert ? cert.subject.attributes.map((x) => `${x.shortName ?? x.name}=${x.value}`).join(", ") : null,
      certFingerprint: fp,
    };
  } catch (e) {
    return { ...none, present: true, error: `The signature could not be read: ${(e as Error).message}` };
  }
}
