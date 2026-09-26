import "server-only";
import { HttpError } from "./session";
import { sha256 } from "./versioning";

export const MAX_ATTACHMENT = 25 * 1024 * 1024;

/** Allow-list: extension → canonical content type. */
const ALLOWED: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  qet: "application/xml",
  elmt: "application/xml",
  dxf: "application/dxf",
  dwg: "application/acad",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  step: "application/step",
  stp: "application/step",
};

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

/** Validates an uploaded file (size, extension + declared type) and returns normalized metadata. */
export async function readUpload(f: File, max = MAX_ATTACHMENT) {
  if (!f || typeof f.arrayBuffer !== "function") throw new HttpError(400, "No file uploaded");
  if (f.size === 0) throw new HttpError(400, "The file is empty");
  if (f.size > max) throw new HttpError(413, `File exceeds the ${Math.round(max / 1024 / 1024)} MB limit`);
  const name = (f.name || "file").split(/[\\/]/).pop()!.slice(0, 200);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const mime = ALLOWED[ext];
  if (!mime) throw new HttpError(415, `File type .${ext || "?"} is not allowed`);
  const declared = (f.type || "").toLowerCase();
  if (declared && /^(text\/html|application\/(x-)?javascript|application\/x-msdownload|application\/x-sh)/.test(declared)) throw new HttpError(415, "This content type is not allowed");
  const buf = Buffer.from(await f.arrayBuffer());
  if (buf.byteLength > max) throw new HttpError(413, "File too large");
  return { filename: name, mime, size: buf.byteLength, sha256: sha256(buf), data: buf };
}
