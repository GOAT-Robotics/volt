import "server-only";
import { rgb, type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import { exportPdf } from "@/core/render/pdf";
import type { Doc } from "@/core/model";
import { db, J } from "../db";
import { canonicalPages, versionHashes } from "./canonical";
import { getProvider, type SignatureEvidence } from "./provider";

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };

const A4: [number, number] = [595.28, 841.89];
const M = 48;

function clean(font: PDFFont, s: string) {
  let out = "";
  for (const ch of s.replace(/\t/g, "  ").replace(/\r/g, "")) {
    if (ch === "\n") {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(private pdf: PDFDocument, private f: Fonts, private footer: string) {
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage(A4);
    this.pageNo++;
    this.y = A4[1] - M;
    this.page.drawText(clean(this.f.regular, this.footer), { x: M, y: 24, size: 7, font: this.f.regular, color: rgb(0.4, 0.4, 0.45) });
  }
  ensure(h: number) {
    if (this.y - h < M) this.newPage();
  }
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of clean(font, text).split("\n")) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const tryLine = line + word;
        if (font.widthOfTextAtSize(tryLine, size) <= width) {
          line = tryLine;
          continue;
        }
        if (line.trim()) out.push(line.trimEnd());
        // hard-break long tokens (hashes, seals)
        let w = word.trimStart();
        while (font.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      }
      out.push(line.trimEnd());
    }
    return out;
  }
  text(s: string, o: { size?: number; font?: keyof Fonts; color?: [number, number, number]; indent?: number; gap?: number } = {}) {
    const size = o.size ?? 9;
    const font = this.f[o.font ?? "regular"];
    const x = M + (o.indent ?? 0);
    const lines = this.wrap(s, font, size, A4[0] - M - x);
    for (const l of lines) {
      this.ensure(size * 1.35);
      this.page.drawText(l, { x, y: this.y - size, size, font, color: rgb(...(o.color ?? [0.1, 0.1, 0.12])) });
      this.y -= size * 1.35;
    }
    this.y -= o.gap ?? 0;
  }
  kv(k: string, v: string, indent = 0) {
    const size = 8.5;
    const kw = 120;
    const x = M + indent;
    const lines = this.wrap(v || "—", this.f.regular, size, A4[0] - M - x - kw);
    this.ensure(size * 1.35 * Math.min(lines.length, 3));
    this.page.drawText(clean(this.f.bold, k), { x, y: this.y - size, size, font: this.f.bold, color: rgb(0.3, 0.3, 0.35) });
    for (const l of lines) {
      this.ensure(size * 1.35);
      this.page.drawText(l, { x: x + kw, y: this.y - size, size, font: this.f.regular, color: rgb(0.1, 0.1, 0.12) });
      this.y -= size * 1.35;
    }
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: M, y: this.y - 4 }, end: { x: A4[0] - M, y: this.y - 4 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.83) });
    this.y -= 12;
  }
  heading(s: string) {
    this.ensure(40);
    this.y -= 6;
    this.text(s, { size: 12, font: "bold", gap: 4 });
  }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—");

/** Canonical drawing PDF + appended "Approval & signature record" pages. */
export async function buildReleasePdf(versionId: string, verifyBase: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const v = await db.version.findUniqueOrThrow({ where: { id: versionId }, include: { project: true, reviews: { include: { assignments: true }, orderBy: { createdAt: "asc" } }, signatures: { orderBy: [{ createdAt: "asc" }, { order: "asc" }] } } });
  const doc = J.parse<Doc>(v.doc, null as unknown as Doc);
  const h = await versionHashes(doc, v.label);
  const uids = new Set<string>([v.createdById]);
  for (const r of v.reviews) {
    uids.add(r.submittedById);
    for (const a of r.assignments) [a.userId, a.decidedById].forEach((x) => x && uids.add(x));
  }
  for (const s of v.signatures) [s.signatoryId, s.requestedById].forEach((x) => uids.add(x));
  const users = new Map((await db.user.findMany({ where: { id: { in: [...uids] } } })).map((u) => [u.id, u]));
  const nm = (id: string | null | undefined) => (id ? users.get(id)?.name ?? "Unknown user" : "—");
  const keyInfo = await (await getProvider("builtin")).publicInfo().catch(() => null);

  const bytes = await exportPdf(doc, {
    pages: canonicalPages(doc),
    paper: "A3",
    version: v.label,
    rasterizeSvg: async (svg, w, h) => {
      try {
        const sharp = (await import("sharp")).default;
        return new Uint8Array(await sharp(Buffer.from(svg)).resize(w, h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
      } catch {
        return null;
      }
    },
    title: `${v.project.name} v${v.label} — release`,
    subject: `Released drawing with approval & signature record`,
    keywords: ["volt", v.project.number ?? "", `v${v.label}`, `doc-sha256:${h.docHash}`],
    append: async (pdf, fonts) => {
      const w = new Writer(pdf, fonts, `${v.project.name} · v${v.label} · Approval & signature record · document sha256 ${h.docHash}`);
      w.text("Approval & signature record", { size: 16, font: "bold", gap: 2 });
      w.text("Generated by Volt from the immutable version record. Verify each signature online with the URL shown.", { size: 8.5, color: [0.35, 0.35, 0.4], gap: 8 });
      w.kv("Project", `${v.project.name}${v.project.number ? ` (${v.project.number})` : ""}`);
      w.kv("Version", `v${v.label}`);
      w.kv("Status", v.status);
      w.kv("Summary", v.summary);
      w.kv("Author", nm(v.createdById));
      w.kv("Submitted", iso(v.submittedAt));
      w.kv("Approved", iso(v.approvedAt));
      w.kv("Signed", iso(v.signedAt));
      w.kv("Released", iso(v.releasedAt));
      if (v.endedAt) w.kv("Ended", `${iso(v.endedAt)} — ${v.endReason ?? ""}`);
      w.kv("Document SHA-256", h.docHash);
      w.kv("Drawing PDF SHA-256", h.pdfHash);
      w.kv("Drawing pages", String(canonicalPages(doc).length));
      w.rule();

      w.heading("Reviews & decisions");
      if (!v.reviews.length) w.text("No review records.", { size: 9, color: [0.4, 0.4, 0.45] });
      for (const [i, r] of v.reviews.entries()) {
        w.text(`Review ${i + 1} — ${r.status}${r.sequential ? " (sequential)" : ""}`, { size: 10, font: "bold", gap: 2 });
        w.kv("Submitted by", `${nm(r.submittedById)} on ${iso(r.createdAt)}`, 8);
        if (r.dueDate) w.kv("Due", iso(r.dueDate), 8);
        if (r.instructions) w.kv("Instructions", r.instructions, 8);
        if (r.closedAt) w.kv("Closed", iso(r.closedAt), 8);
        for (const a of [...r.assignments].sort((x, y) => x.order - y.order)) {
          const who = a.userId ? nm(a.userId) : `Group: ${a.groupName ?? a.groupId}`;
          const by = a.decidedById && a.decidedById !== a.userId ? ` by ${nm(a.decidedById)}` : "";
          w.kv(`${a.order + 1}. ${a.canApprove ? "Approver" : "Reviewer"}`, `${who} — ${a.decision}${by}${a.decidedAt ? ` on ${iso(a.decidedAt)}` : ""}${a.reason ? ` — “${a.reason}”` : ""}`, 8);
        }
        w.y -= 6;
      }
      w.rule();

      w.heading("Electronic signatures");
      if (!v.signatures.length) w.text("No signatures were requested for this version.", { size: 9, color: [0.4, 0.4, 0.45] });
      for (const s of v.signatures) {
        const ev = J.parse<SignatureEvidence | null>(s.evidence, null);
        w.text(`${nm(s.signatoryId)} — ${s.status}`, { size: 10, font: "bold", gap: 2 });
        w.kv("Purpose", s.purpose, 8);
        w.kv("Requested by", `${nm(s.requestedById)} on ${iso(s.createdAt)}`, 8);
        if (s.status === "DECLINED" || s.status === "CANCELLED") w.kv("Reason", s.declineReason ?? "", 8);
        if (ev && s.seal) {
          w.kv("Signatory", `${ev.signatory.name} <${ev.signatory.email}>${ev.signatory.entraOid ? ` · Entra OID ${ev.signatory.entraOid}` : ""}`, 8);
          w.kv("Signed at", iso(ev.signedAt), 8);
          w.kv("Authenticated at", iso(new Date(ev.authTime)), 8);
          w.kv("IP / client", `${ev.ip ?? "—"} · ${ev.userAgent}`, 8);
          w.kv("Statement", ev.statement, 8);
          w.kv("Document SHA-256", ev.docHash, 8);
          w.kv("PDF SHA-256", ev.pdfHash, 8);
          w.kv("Provider", `${ev.provider}${ev.keyId ? ` · key ${ev.keyId}` : ""}`, 8);
          w.kv("Seal (Ed25519, b64)", s.seal, 8);
          w.kv("Verify", `${verifyBase}/api/signatures/${s.id}/verify`, 8);
        }
        w.y -= 6;
      }
      w.rule();
      w.heading("Verification key");
      if (keyInfo) {
        w.kv("Algorithm", keyInfo.algorithm);
        w.kv("Key fingerprint", keyInfo.keyId);
        if (keyInfo.publicKeyPem) w.text(keyInfo.publicKeyPem, { size: 7.5, font: "regular", color: [0.25, 0.25, 0.3] });
      }
      w.text(
        "The seal is an Ed25519 signature by this Volt installation over the canonical (sorted-key JSON) evidence shown above. It binds the signatory's authenticated identity, the time, the statement and the SHA-256 hashes of the stored document and of the canonical drawing PDF (pages 1–" +
          canonicalPages(doc).length +
          " of this file, regenerated deterministically). It is an application-level electronic signature record; it is not asserted to be a qualified or advanced electronic signature.",
        { size: 8, color: [0.35, 0.35, 0.4] },
      );
    },
  });
  const safe = `${v.project.number ? v.project.number + "_" : ""}${v.project.name}`.replace(/[^\w.-]+/g, "_").slice(0, 80);
  return { bytes, filename: `${safe}_v${v.label}_release.pdf` };
}
