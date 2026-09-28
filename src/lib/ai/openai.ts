/**
 * OpenAI client for element generation (server only). Configured by environment:
 *   OPENAI_API_KEY   required — AI features are hidden without it
 *   OPENAI_MODEL     optional, default gpt-4.1 (must support images + structured outputs)
 *   OPENAI_BASE_URL  optional, e.g. an Azure OpenAI / proxy endpoint (default https://api.openai.com/v1)
 */
import "server-only";
import { HttpError } from "@/lib/session";
import { AI_SYMBOL_SCHEMA, AI_SYSTEM_PROMPT, type AiSymbol } from "@/lib/library/ai-symbol";

export const aiEnabled = () => !!process.env.OPENAI_API_KEY?.trim();
export const aiModel = () => process.env.OPENAI_MODEL?.trim() || "gpt-4.1";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } };

export async function generateSymbol(input: { description?: string; image?: string; previous?: AiSymbol; instruction?: string }): Promise<{ symbol: AiSymbol; usage?: unknown }> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new HttpError(503, "AI is not configured: set OPENAI_API_KEY in the server environment", "AI_DISABLED");
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");

  const first: Part[] = [];
  const desc = input.description?.trim();
  first.push({ type: "text", text: desc ? `Draw this element: ${desc}` : "Draw the element shown in the image." });
  if (input.image) {
    first.push({ type: "text", text: "Reference image (a hand sketch or a picture of the symbol / device) follows. Use it as the shape to reproduce." });
    first.push({ type: "image_url", image_url: { url: input.image, detail: "high" } });
  }
  const messages: { role: "system" | "user" | "assistant"; content: string | Part[] }[] = [
    { role: "system", content: AI_SYSTEM_PROMPT },
    { role: "user", content: first },
  ];
  if (input.previous && input.instruction?.trim()) {
    messages.push({ role: "assistant", content: JSON.stringify(input.previous) });
    messages.push({ role: "user", content: `Change the symbol: ${input.instruction.trim()}\nReturn the complete updated symbol.` });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: aiModel(),
        messages,
        response_format: { type: "json_schema", json_schema: { name: "electrical_symbol", strict: true, schema: AI_SYMBOL_SCHEMA } },
      }),
    });
  } catch (e) {
    throw new HttpError(502, (e as Error).name === "AbortError" ? "The AI took too long to answer — try again" : "Could not reach the AI service");
  } finally {
    clearTimeout(timer);
  }
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string; refusal?: string } }[]; error?: { message?: string }; usage?: unknown } | null;
  if (!res.ok) {
    const msg = j?.error?.message ?? `HTTP ${res.status}`;
    console.error("[ai] OpenAI error", res.status, msg);
    throw new HttpError(res.status === 429 ? 429 : 502, res.status === 401 ? "The OpenAI API key was rejected" : `AI service error: ${msg}`.slice(0, 300));
  }
  const m = j?.choices?.[0]?.message;
  if (m?.refusal) throw new HttpError(422, `The AI declined: ${m.refusal}`.slice(0, 300));
  try {
    return { symbol: JSON.parse(m?.content ?? "") as AiSymbol, usage: j?.usage };
  } catch {
    throw new HttpError(502, "The AI returned an unreadable answer — try again");
  }
}
