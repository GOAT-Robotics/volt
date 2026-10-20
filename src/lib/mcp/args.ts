/**
 * Checking tool arguments against their schemas. Some clients send nested objects and lists as JSON
 * text ("{\"width\": 0}"); those are read as what they say when the arguments do not fit as sent.
 */
import { z } from "zod";

export function parseArgs(schema: z.ZodType, args: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  let parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const again = schema.safeParse(unstringify(args ?? {}));
    if (again.success) parsed = again;
  }
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map(issueText).join("; ")}` };
  return { ok: true, data: parsed.data };
}

/** JSON text that stands for an object or a list, parsed (nested values too) */
export function unstringify(v: unknown, depth = 0): unknown {
  if (depth > 6) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return unstringify(JSON.parse(s), depth + 1);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => unstringify(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unstringify(x, depth + 1)]));
  return v;
}

/** a validation problem in words: for "one of these shapes" values, what the closest shape wanted */
export function issueText(i: z.core.$ZodIssue): string {
  const at = i.path.join(".") || "input";
  if (i.code === "invalid_union" && "errors" in i && Array.isArray(i.errors) && i.errors.length) {
    // the alternative that got furthest (fewest problems) says the most
    const best = [...(i.errors as z.core.$ZodIssue[][])].sort((a, b) => a.length - b.length)[0];
    if (best?.length) return best.map((x) => `${[...i.path, ...x.path].join(".") || at}: ${x.message}`).join(", ");
  }
  return `${at}: ${i.message}`;
}
