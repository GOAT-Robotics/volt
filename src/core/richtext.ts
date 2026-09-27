/**
 * Formatted free text: paragraphs, bullets and numbered lists, headings, inline bold/italic,
 * word wrap at a box width, alignment (incl. justify), line and paragraph spacing, padding,
 * border and background.
 *
 * Markup (only for texts with `rich` set; plain texts are drawn as typed):
 *   "- item" / "* item" / "• item"   bullet            "1. item" / "a) item"   numbered (as written)
 *   two leading spaces per level     indent            "# Title" / "## Subtitle"  headings
 *   "---"                            horizontal rule   **bold**  *italic*  \* literal
 */
import type { FreeText, TextStyle } from "./model";

export type RichOptions = NonNullable<FreeText["rich"]>;
export type Run = { text: string; bold: boolean; italic: boolean };
export type Para = { kind: "p" | "h1" | "h2" | "rule"; marker: string | null; level: number; runs: Run[] };

/** one drawn word / text piece, in box coordinates (top-left of the glyph box) */
export type RichItem = { text: string; x: number; y: number; size: number; weight: number; italic: boolean };
export type RichLayout = { w: number; h: number; items: RichItem[]; rules: { x1: number; x2: number; y: number }[]; pad: number };

type Measure = (text: string, size: number, font: string, weight?: number) => number;

export function parseInline(s: string): Run[] {
  const out: Run[] = [];
  let bold = false, italic = false, buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, bold, italic });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      buf += s[++i];
      continue;
    }
    if (c === "*" && s[i + 1] === "*") {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    if (c === "*" || (c === "_" && (i === 0 || /\W/.test(s[i - 1]) || italic))) {
      // a lone "*" opens italics only when a closing one follows
      if (!italic && s.indexOf(c, i + 1) < 0) {
        buf += c;
        continue;
      }
      flush();
      italic = !italic;
      continue;
    }
    buf += c;
  }
  flush();
  return out;
}

export function parseRich(text: string): Para[] {
  return text.split("\n").map((raw) => {
    const lead = /^[ \t]*/.exec(raw)![0];
    const level = Math.min(6, Math.floor(lead.replace(/\t/g, "  ").length / 2));
    const line = raw.slice(lead.length);
    if (/^-{3,}\s*$/.test(line)) return { kind: "rule", marker: null, level: 0, runs: [] };
    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    if (h) return { kind: h[1].length === 1 ? "h1" : "h2", marker: null, level, runs: parseInline(h[2]) };
    const b = /^[-*•]\s+(.*)$/.exec(line);
    if (b) return { kind: "p", marker: "•", level, runs: parseInline(b[1]) };
    const n = /^(\d{1,3}|[a-zA-Z])([.)])\s+(.*)$/.exec(line);
    if (n) return { kind: "p", marker: `${n[1]}${n[2]}`, level, runs: parseInline(n[3]) };
    return { kind: "p", marker: null, level, runs: parseInline(line) };
  });
}

/** Markup removed (for plain-text exports such as QElectroTech) */
export function plainText(text: string): string {
  return parseRich(text)
    .map((p) => (p.kind === "rule" ? "————" : `${"  ".repeat(p.level)}${p.marker ? p.marker + " " : ""}${p.runs.map((r) => r.text).join("")}`))
    .join("\n");
}

const PT = 4 / 3;

export function layoutRich(text: string, st: TextStyle, o: RichOptions, measure: Measure): RichLayout {
  const base = st.size * PT;
  const lh = o.lineHeight ?? st.lineHeight;
  const gap = (o.paraGap ?? 0) * PT;
  const pad = o.padding ?? 4;
  const indentW = base * 1.6;
  const maxW = o.width && o.width > 0 ? o.width - pad * 2 : Infinity;
  const align = o.align ?? st.align ?? "left";
  const items: RichItem[] = [];
  const rules: RichLayout["rules"] = [];
  let y = pad;
  let widest = 0;
  const paras = parseRich(text);
  const lines: { items: RichItem[]; width: number; left: number; avail: number; last: boolean; spaces: number[] }[] = [];

  for (const p of paras) {
    if (p.kind === "rule") {
      rules.push({ x1: 0, x2: 0, y: y + base * 0.5 });
      y += base + gap;
      continue;
    }
    const size = p.kind === "h1" ? base * 1.45 : p.kind === "h2" ? base * 1.2 : base;
    const headWeight = p.kind === "p" ? 0 : 700;
    const lineH = size * lh;
    const left = pad + p.level * indentW + (p.marker ? indentW : 0);
    const avail = maxW === Infinity ? Infinity : Math.max(size * 2, maxW - (left - pad));
    if (p.marker) {
      const mw = measure(p.marker, size, st.font, st.weight);
      items.push({ text: p.marker, x: left - indentW * 0.35 - mw, y, size, weight: Math.max(st.weight, headWeight), italic: st.italic });
    }
    // words with their style; spaces kept as separate measurable gaps
    const words: { text: string; bold: boolean; italic: boolean; space: boolean }[] = [];
    for (const r of p.runs) for (const part of r.text.split(/(\s+)/)) if (part) words.push({ text: part, bold: r.bold, italic: r.italic, space: /^\s+$/.test(part) });
    let line: RichItem[] = [];
    let spaces: number[] = [];
    let x = 0;
    const push = (last: boolean) => {
      // trailing spaces do not count
      while (line.length && /^\s+$/.test(line[line.length - 1].text)) {
        line.pop();
        spaces = spaces.filter((i) => i < line.length);
      }
      const width = line.length ? line[line.length - 1].x + measure(line[line.length - 1].text, line[line.length - 1].size, st.font, line[line.length - 1].weight) : 0;
      lines.push({ items: line.map((it) => ({ ...it, y })), width, left, avail, last, spaces });
      widest = Math.max(widest, left - pad + width);
      y += lineH;
      line = [];
      spaces = [];
      x = 0;
    };
    for (const w of words) {
      const weight = w.bold ? 700 : Math.max(st.weight, headWeight);
      const ww = measure(w.text, size, st.font, weight);
      if (!w.space && x > 0 && x + ww > avail) push(false);
      if (w.space && x === 0) continue;
      if (w.space) spaces.push(line.length);
      line.push({ text: w.text, x, y, size, weight, italic: w.italic || st.italic });
      x += ww;
    }
    push(true);
    y += gap;
  }
  if (paras.length) y -= gap;
  const contentW = maxW === Infinity ? widest : maxW;
  // alignment inside the text column
  for (const l of lines) {
    const colW = l.avail === Infinity ? contentW - (l.left - pad) : l.avail;
    const extra = colW - l.width;
    let shift = 0;
    let perSpace = 0;
    if (align === "center") shift = extra / 2;
    else if (align === "right") shift = extra;
    else if (align === "justify" && !l.last && l.spaces.length && extra > 0 && l.avail !== Infinity) perSpace = extra / l.spaces.length;
    let add = 0;
    l.items.forEach((it, i) => {
      if (perSpace && l.spaces.includes(i)) add += perSpace;
      items.push({ ...it, x: l.left + it.x + shift + (perSpace && !l.spaces.includes(i) ? add : 0) });
    });
  }
  const w = contentW + pad * 2;
  for (const r of rules) ((r.x1 = pad), (r.x2 = w - pad));
  // markers of centered / right-aligned paragraphs stay with the list column
  return { w: Math.max(w, pad * 2 + 4), h: Math.max(y + pad, pad * 2 + base * lh), items: items.filter((i) => !/^\s+$/.test(i.text)), rules, pad };
}
