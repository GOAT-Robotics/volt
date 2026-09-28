import { afterEach, describe, expect, it, vi } from "vitest";
import { aiSymbolToDef, AI_SYMBOL_SCHEMA, type AiSymbol } from "../ai-symbol";
import { serializeElmt } from "@/core/qet/elmt";

vi.mock("@/lib/session", () => ({ HttpError: class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } } }));

const shape = (o: Partial<AiSymbol["shapes"][number]>): AiSymbol["shapes"][number] => ({ kind: "line", points: [], x: null, y: null, w: null, h: null, start_deg: null, sweep_deg: null, text: null, size: null, filled: false, dashed: false, ...o });
const coil: AiSymbol = {
  name: "Contactor coil 24 V DC",
  category: "Relays & contactors/Coils",
  prefix: "K",
  description: "Coil",
  link_type: "master",
  shapes: [
    shape({ kind: "rect", x: -10, y: -10, w: 20, h: 20 }),
    shape({ kind: "line", points: [{ x: 0, y: -20 }, { x: 0, y: -10 }] }),
    shape({ kind: "line", points: [{ x: 0, y: 10 }, { x: 0, y: 20 }] }),
    shape({ kind: "text", x: 3, y: -12, text: "A1", size: 6 }),
    shape({ kind: "arc", x: -5, y: -5, w: 10, h: 10, start_deg: 0, sweep_deg: 180 }),
  ],
  pins: [
    { x: 0, y: -20, direction: "n", number: "A1", name: "A1" },
    { x: 1, y: 21, direction: "s", number: "A2", name: "" },
    { x: 0, y: -20, direction: "n", number: "dup", name: "" },
  ],
  notes: "",
};

describe("AI symbols", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts, snaps pins, drops duplicates and adds a reference label", () => {
    const { def, warnings } = aiSymbolToDef(coil);
    expect(def.linkType).toBe("master");
    expect(def.prefix).toBe("K");
    expect(def.pins.map((p) => [p.number, p.x, p.y, p.orient])).toEqual([["A1", 0, -20, "n"], ["A2", 0, 20, "s"]]);
    expect(def.pins[1].name).toBe("A2");
    expect(warnings.join(" ")).toMatch(/grid/);
    expect(warnings.join(" ")).toMatch(/dropped/);
    expect(def.prims.some((p) => p.t === "dyntext" && p.info === "label")).toBe(true);
    expect(def.prims.filter((p) => p.t === "line")).toHaveLength(2);
    const xml = serializeElmt(def);
    expect(xml).toContain('link_type="master"');
    expect(xml).toContain("<terminal");
  });

  it("schema is strict (every object closed, every property required)", () => {
    const check = (o: Record<string, unknown>) => {
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect(Object.keys(o.properties as object).sort()).toEqual([...(o.required as string[])].sort());
        for (const v of Object.values(o.properties as object)) check(v as Record<string, unknown>);
      }
      if (o.type === "array") check(o.items as Record<string, unknown>);
    };
    check(AI_SYMBOL_SCHEMA as unknown as Record<string, unknown>);
  });

  it("calls OpenAI with structured output and the image", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(coil) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { generateSymbol } = await import("@/lib/ai/openai");
    const r = await generateSymbol({ description: "coil", image: "data:image/png;base64,AAAA" });
    expect(r.symbol.name).toBe(coil.name);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const b = JSON.parse(String(init.body));
    expect(b.model).toBe("gpt-test");
    expect(b.response_format.json_schema.strict).toBe(true);
    expect(JSON.stringify(b.messages)).toContain("data:image/png;base64,AAAA");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });
});
