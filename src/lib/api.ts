import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { HttpError } from "./session";

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response | unknown>;

/** Route-handler wrapper: JSON responses + uniform error mapping. */
export function route<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      const out = await fn(req, ctx);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: e.issues }, { status: 400 });
      console.error("[api]", e);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  };
}

/**
 * Reads a request body with a hard size cap. Content-Length alone is not enough: chunked
 * requests have none, and req.text()/formData() would buffer whatever arrives.
 */
export async function readBody(req: Request, max: number, what = "Request"): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, `${what} too large (max ${Math.round(max / 1048576)} MB)`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, `${what} too large (max ${Math.round(max / 1048576)} MB)`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.byteLength));
  return out;
}

/** multipart/form-data with a size cap */
export async function formData(req: Request, max: number, what = "Upload"): Promise<FormData> {
  const buf = await readBody(req, max, what);
  try {
    return await new Response(buf, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new HttpError(400, "Expected multipart form data");
  }
}

/** default cap for JSON request bodies */
export const MAX_JSON = 2 * 1024 * 1024;

export async function body<T>(req: Request, schema: ZodType<T>, max = MAX_JSON): Promise<T> {
  const buf = await readBody(req, max);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return schema.parse(raw);
}
