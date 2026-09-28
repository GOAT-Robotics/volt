"use client";
/**
 * "Describe or sketch" element creation: a description, a sketch drawn on the pad or an uploaded
 * picture go to OpenAI (server side); the symbol comes back as clean grid-aligned geometry with
 * pins, previewed in the wizard, and can be refined with follow-up instructions.
 */
import { useEffect, useRef, useState } from "react";
import { ImageUp, Loader2, PenLine, Sparkles, Type, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import type { ElementDef } from "@/core/model";
import { aiSymbolToDef, type AiSymbol } from "@/lib/library/ai-symbol";
import { SketchPad, type SketchPadHandle } from "./SketchPad";

type Mode = "text" | "sketch" | "upload";
const EXAMPLES = [
  "Contactor coil 24 V DC, pins A1 (top) and A2 (bottom)",
  "3-pole circuit breaker with thermal and magnetic trip, pins 1-2, 3-4, 5-6",
  "Inductive proximity sensor PNP, 3 wires: BN +24V, BU 0V, BK signal",
  "8-way terminal strip, pins 1–8 on the left and right",
  "Emergency stop push button, mushroom head, NC contact 11-12",
];

/** Downscale an uploaded picture so the request stays small. */
async function fileToDataUrl(f: File, max = 1280): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Could not read that image"));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AiElementPanel({ onResult }: { onResult: (r: { def: ElementDef; symbol: AiSymbol; warnings: string[] } | null) => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; model: string | null } | null>(null);
  const [mode, setMode] = useState<Mode>("sketch");
  const [desc, setDesc] = useState("");
  const [upload, setUpload] = useState<{ name: string; url: string } | null>(null);
  const [symbol, setSymbol] = useState<AiSymbol | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"gen" | "refine" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const pad = useRef<SketchPadHandle>(null);

  useEffect(() => {
    api<{ enabled: boolean; model: string | null }>("/api/ai/element")
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, model: null }));
  }, []);

  const image = () => (mode === "sketch" ? pad.current?.toPng() ?? undefined : mode === "upload" ? upload?.url : undefined);
  const run = async (refine: boolean) => {
    const img = image();
    if (!refine && !desc.trim() && !img) return setError(mode === "sketch" ? "Draw something or describe the element" : mode === "upload" ? "Choose a picture or describe the element" : "Describe the element");
    setBusy(refine ? "refine" : "gen");
    setError(null);
    try {
      const j = await api<{ symbol: AiSymbol }>("/api/ai/element", {
        method: "POST",
        json: { description: desc.trim() || undefined, image: img, ...(refine && symbol ? { previous: symbol, instruction } : {}) },
      });
      const r = aiSymbolToDef(j.symbol);
      setSymbol(j.symbol);
      setWarnings(r.warnings);
      if (refine) setInstruction("");
      onResult({ def: r.def, symbol: j.symbol, warnings: r.warnings });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (status && !status.enabled)
    return (
      <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-xs text-warning">
        AI element drawing is not set up on this server. An administrator adds <code className="font-mono">OPENAI_API_KEY</code> (and optionally <code className="font-mono">OPENAI_MODEL</code>) to the server&apos;s <code className="font-mono">.env</code> and restarts Volt.
      </div>
    );

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div>
        <label className="mb-1 block text-2xs font-medium text-muted" htmlFor="ai-desc">
          Describe the element
        </label>
        <Textarea
          id="ai-desc"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(false);
          }}
          rows={3}
          placeholder="e.g. Contactor coil 24 V DC with pins A1 and A2 — or describe what your sketch / picture shows"
          className="text-xs"
        />
        <div className="mt-1 flex flex-wrap gap-1">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" onClick={() => setDesc(x)} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-fg">
              {x.length > 42 ? x.slice(0, 40) + "…" : x}
            </button>
          ))}
        </div>
      </div>

      <div className="flex rounded-md border border-border p-0.5 text-2xs" role="tablist">
        {(
          [
            ["sketch", <PenLine key="s" className="size-3.5" />, "Sketch it"],
            ["upload", <ImageUp key="u" className="size-3.5" />, "Upload picture"],
            ["text", <Type key="t" className="size-3.5" />, "Text only"],
          ] as const
        ).map(([m, icon, label]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1", mode === m ? "bg-hover font-medium text-fg" : "text-subtle")}>
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className={mode === "sketch" ? "" : "hidden"}>
        <SketchPad ref={pad} />
        <p className="mt-1 text-[10px] text-subtle">Rough is fine: draw the symbol and short strokes where the wires connect. The AI redraws it cleanly on the grid.</p>
      </div>
      {mode === "upload" && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong px-4 py-5 text-center hover:bg-hover">
          {upload ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={upload.url} alt="" className="max-h-40 max-w-full rounded" />
              <span className="flex items-center gap-1 text-2xs text-muted">
                {upload.name}
                <button type="button" onClick={(e) => (e.preventDefault(), setUpload(null))} aria-label="Remove picture" className="hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            </>
          ) : (
            <>
              <ImageUp className="size-5 text-subtle" />
              <span className="text-xs font-medium">Photo of a sketch, a datasheet symbol or the device</span>
              <span className="text-2xs text-muted">PNG or JPEG</span>
            </>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                setUpload({ name: f.name, url: await fileToDataUrl(f) });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" variant="primary" onClick={() => run(false)} disabled={!!busy || !status}>
          {busy === "gen" ? <Loader2 className="animate-spin" /> : <Sparkles />} {symbol ? "Generate again" : "Generate element"}
        </Button>
        {status?.model && <span className="text-[10px] text-subtle">OpenAI · {status.model} · ⌘↵</span>}
      </div>

      {symbol && (
        <div className="space-y-1.5 rounded-md bg-hover/60 p-2">
          {symbol.notes && <p className="text-2xs text-muted">{symbol.notes}</p>}
          <div className="flex gap-1.5">
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && instruction.trim()) run(true);
              }}
              placeholder="Change it: e.g. add a PE pin at the bottom, make it wider, pins 13-14"
              className="h-8 text-xs"
              aria-label="Change the element"
            />
            <Button type="button" variant="secondary" onClick={() => run(true)} disabled={!!busy || !instruction.trim()}>
              {busy === "refine" ? <Loader2 className="animate-spin" /> : <Wand2 />} Apply
            </Button>
          </div>
        </div>
      )}
      {warnings.map((w, i) => (
        <p key={i} className="text-2xs text-warning">
          {w}
        </p>
      ))}
      {error && <p className="text-2xs text-danger">{error}</p>}
    </div>
  );
}
