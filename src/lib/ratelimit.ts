import { HttpError } from "./session";

/**
 * In-memory sliding-window limiter (one server process). Protects the expensive endpoints
 * (imports, exports, PDF rendering, signing) from being hammered by one user or script.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const wait = Math.ceil((windowMs - (now - arr[0])) / 1000);
    throw new HttpError(429, `Too many requests — try again in ${wait} s`, "RATE_LIMITED");
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
}
