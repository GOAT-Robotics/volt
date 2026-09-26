"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { inputCls } from "@/components/ui/input";
import { QET_COLORS } from "@/core/styles";

/** Numeric input that keeps a local draft while typing and commits valid numbers. */
export function NumField({ label, value, onChange, step = 1, min, max, disabled, suffix, className }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; disabled?: boolean; suffix?: string; className?: string }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const commit = (s: string) => {
    const v = Number(s.replace(",", "."));
    if (s.trim() === "" || !Number.isFinite(v)) return;
    const c = Math.round((min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, v) : v) : max !== undefined ? Math.min(max, v) : v) * 100) / 100;
    if (c !== value) onChange(c);
  };
  return (
    <label className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      <span className="relative">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          value={draft}
          aria-label={label}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            setDraft(String(value));
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
          className={cn(inputCls, "tabular pr-5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
        />
        {suffix && <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-subtle">{suffix}</span>}
      </span>
    </label>
  );
}

export function TextField({ label, value, onChange, disabled, placeholder, id, multiline }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; id?: string; multiline?: boolean }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      {multiline ? (
        <textarea id={id} rows={2} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={cn(inputCls, "h-auto py-1 leading-snug")} />
      ) : (
        <input id={id} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={inputCls} />
      )}
    </label>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={cn(inputCls, "pr-5")}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
  );
}

export const LINE_STYLES = [
  { v: "normal", l: "Solid" },
  { v: "dashed", l: "Dashed" },
  { v: "dotted", l: "Dotted" },
  { v: "dashdotted", l: "Dash-dot" },
] as const;
export const LINE_WEIGHTS = [
  { v: "none", l: "None (no outline)" },
  { v: "thin", l: "Thin (0.5)" },
  { v: "normal", l: "Normal (1)" },
  { v: "hight", l: "Thick (2)" },
  { v: "eleve", l: "Very thick (5)" },
] as const;
export const COLOR_NAMES: { v: string; l: string }[] = [
  { v: "black", l: "Black" },
  { v: "white", l: "White" },
  { v: "red", l: "Red" },
  { v: "green", l: "Green" },
  { v: "blue", l: "Blue" },
  { v: "gray", l: "Gray" },
  { v: "lightgray", l: "Light gray" },
  { v: "brun", l: "Brown" },
  { v: "yellow", l: "Yellow" },
  { v: "orange", l: "Orange" },
  { v: "cyan", l: "Cyan" },
  { v: "magenta", l: "Magenta" },
  { v: "purple", l: "Purple" },
];
export const FILLINGS: { v: string; l: string }[] = [{ v: "none", l: "No fill" }, ...COLOR_NAMES, { v: "hor", l: "Hatch — horizontal" }, { v: "ver", l: "Hatch — vertical" }, { v: "bdiag", l: "Hatch — diagonal \\" }, { v: "fdiag", l: "Hatch — diagonal /" }];

export function Swatches({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const css = QET_COLORS[o.v];
          const hatch = ["hor", "ver", "bdiag", "fdiag"].includes(o.v);
          return (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={value === o.v}
              aria-label={o.l}
              title={o.l}
              disabled={disabled}
              onClick={() => onChange(o.v)}
              className={cn("relative size-5 rounded border border-border-strong disabled:opacity-40", value === o.v && "ring-2 ring-accent ring-offset-1 ring-offset-panel")}
              style={{
                background: o.v === "none" ? "linear-gradient(135deg, transparent 45%, #dc2626 45%, #dc2626 55%, transparent 55%)" : hatch ? `repeating-linear-gradient(${o.v === "hor" ? 0 : o.v === "ver" ? 90 : o.v === "bdiag" ? 135 : 45}deg, #888 0 1px, transparent 1px 4px)` : css,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: { v: T; l: React.ReactNode; title?: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      <div className="flex rounded-md border border-border bg-panel-2 p-0.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={cn("flex h-6 flex-1 items-center justify-center rounded text-2xs font-medium text-muted disabled:opacity-40 [&_svg]:size-3.5", value === o.v && "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]")}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}
