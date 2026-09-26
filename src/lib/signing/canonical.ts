import "server-only";
import { exportPdf } from "@/core/render/pdf";
import type { Doc } from "@/core/model";
import { docHash, sha256 } from "../versioning";

/** Pages rendered in the canonical PDF: all non-archived pages, in order. */
export function canonicalPages(doc: Doc) {
  return [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
}

const cache = new Map<string, Uint8Array>();

/** Deterministic A3 PDF of an immutable version (byte-identical for the same doc + label). */
export async function canonicalPdf(doc: Doc, label: string): Promise<Uint8Array> {
  const key = `${docHash(doc)}:${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bytes = await exportPdf(doc, { pages: canonicalPages(doc), paper: "A3", deterministic: true, version: label });
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  cache.set(key, bytes);
  return bytes;
}

export async function versionHashes(doc: Doc, label: string) {
  const pdf = await canonicalPdf(doc, label);
  return { docHash: docHash(doc), pdfHash: sha256(pdf), pdf };
}
