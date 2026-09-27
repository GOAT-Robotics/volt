import "server-only";
import { exportPdf } from "@/core/render/pdf";
import type { Doc } from "@/core/model";
import { docHash, sha256 } from "../versioning";

/** Pages rendered in the canonical PDF: all non-archived pages, in order. */
export function canonicalPages(doc: Doc) {
  return [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
}

/** rendered PDFs by document hash + label, bounded by total size */
const cache = new Map<string, Uint8Array>();
let cachedBytes = 0;
const CACHE_MAX = 48 * 1024 * 1024;

function remember(key: string, bytes: Uint8Array) {
  if (bytes.byteLength > CACHE_MAX / 4) return;
  cache.set(key, bytes);
  cachedBytes += bytes.byteLength;
  while (cachedBytes > CACHE_MAX && cache.size) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    cachedBytes -= v.byteLength;
  }
}

/** Deterministic A3 PDF of an immutable version (byte-identical for the same doc + label). */
export async function canonicalPdf(doc: Doc, label: string, knownHash?: string | null): Promise<Uint8Array> {
  const key = `${knownHash || docHash(doc)}:${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bytes = await exportPdf(doc, { pages: canonicalPages(doc), paper: "A3", deterministic: true, version: label });
  remember(key, bytes);
  return bytes;
}

/** Same, loading the document only on a cache miss (the stored hash identifies it). */
export async function canonicalPdfLazy(docHashStored: string | null, label: string, loadDoc: () => Promise<Doc>): Promise<Uint8Array> {
  if (docHashStored) {
    const hit = cache.get(`${docHashStored}:${label}`);
    if (hit) return hit;
  }
  return canonicalPdf(await loadDoc(), label, docHashStored);
}

export async function versionHashes(doc: Doc, label: string) {
  const pdf = await canonicalPdf(doc, label);
  return { docHash: docHash(doc), pdfHash: sha256(pdf), pdf };
}
