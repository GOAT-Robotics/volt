"use client";
/** Free text: formatted text box (bullets, numbering, headings, bold/italic, wrap, spacing, box). */
import { useEffect, useRef, useState } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Heading1, Heading2, IndentDecrease, IndentIncrease, Italic, List, ListOrdered, Minus, Type } from "lucide-react";
import { useEditor } from "../store";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch, Tip } from "@/components/ui/misc";
import { getPage } from "@/core/ops";
import { TEXT_ROLES, type Doc, type FreeText, type Page, type TextRole } from "@/core/model";
import { ROLE_LABELS } from "@/core/styles";
import { docStyles } from "@/core/render/scene";
import { plainText } from "@/core/richtext";
import { cn } from "@/lib/utils";
import { Commit, Row, Section } from "./Inspector";
import { ColorInput, Overridden } from "./Inspector";

type Rich = NonNullable<FreeText["rich"]>;

/** transforms the selected lines of a textarea */
function editLines(ta: HTMLTextAreaElement, fn: (line: string, i: number) => string): { text: string; start: number; end: number } {
  const v = ta.value;
  const a = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  let b = v.indexOf("\n", ta.selectionEnd);
  if (b < 0) b = v.length;
  const lines = v.slice(a, b).split("\n").map(fn);
  const mid = lines.join("\n");
  return { text: v.slice(0, a) + mid + v.slice(b), start: a, end: a + mid.length };
}

const LIST_RE = /^(\s*)([-*•]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/;

export function FreeTextInspector({ id, page, doc, editable }: { id: string; page: Page; doc: Doc; editable: boolean }) {
  const t = page.texts.find((x) => x.id === id)!;
  const styles = docStyles(doc);
  const eff = { ...styles.text[t.role], ...(t.override ?? {}) };
  const s = useEditor.getState;
  const upd = (label: string, fn: (x: FreeText) => void) =>
    s().apply(label, (d) => {
      const x = getPage(d, page.id).texts.find((y) => y.id === id);
      if (x) fn(x);
    });
  const setRich = (label: string, patch: Partial<Rich>) => upd(label, (x) => (x.rich = { ...(x.rich ?? {}), ...patch }));
  const [v, setV] = useState(t.text);
  useEffect(() => setV(t.text), [t.text]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const rich = t.rich;
  const r = rich ?? {};

  const commit = (text: string, label = "Edit text") => {
    setV(text);
    if (text !== t.text) upd(label, (x) => (x.text = text));
  };
  const lines = (label: string, fn: (line: string, i: number) => string) => {
    const el = ta.current;
    if (!el) return;
    const out = editLines(el, fn);
    commit(out.text, label);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(out.start, out.end);
    });
  };
  const wrap = (mark: string) => {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const sel = value.slice(a, b) || "text";
    const text = value.slice(0, a) + mark + sel + mark + value.slice(b);
    commit(text, mark === "**" ? "Bold" : "Italic");
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + mark.length, a + mark.length + sel.length);
    });
  };
  const strip = (l: string) => l.replace(LIST_RE, "$1").replace(/^(\s*)#{1,2}\s+/, "$1");
  const tools: { icon: React.ReactNode; tip: string; run: () => void }[] = [
    { icon: <Bold />, tip: "Bold (**text**)", run: () => wrap("**") },
    { icon: <Italic />, tip: "Italic (*text*)", run: () => wrap("*") },
    { icon: <Heading1 />, tip: "Heading", run: () => lines("Heading", (l) => (/^\s*# /.test(l) ? strip(l) : l.replace(/^(\s*)/, "$1# ").replace(/^(\s*)# (?:#{1,2}\s+)?/, "$1# "))) },
    { icon: <Heading2 />, tip: "Subheading", run: () => lines("Subheading", (l) => (/^\s*## /.test(l) ? strip(l) : strip(l).replace(/^(\s*)/, "$1## "))) },
    { icon: <List />, tip: "Bullets", run: () => lines("Bullets", (l) => (/^\s*[-*•]\s/.test(l) ? strip(l) : strip(l).replace(/^(\s*)/, "$1- "))) },
    {
      icon: <ListOrdered />,
      tip: "Numbered list",
      run: () => lines("Numbering", (l, i) => (/^\s*\d{1,3}[.)]\s/.test(l) ? strip(l) : strip(l).replace(/^(\s*)/, `$1${i + 1}. `))),
    },
    { icon: <IndentIncrease />, tip: "Indent", run: () => lines("Indent", (l) => "  " + l) },
    { icon: <IndentDecrease />, tip: "Outdent", run: () => lines("Outdent", (l) => l.replace(/^ {1,2}/, "")) },
    { icon: <Minus />, tip: "Horizontal line", run: () => lines("Line", (l) => (l ? `${l}\n---` : "---")) },
  ];

  return (
    <div>
      <Section
        title="Text"
        actions={
          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <Switch
              checked={!!rich}
              disabled={!editable}
              onCheckedChange={(on) =>
                upd(on ? "Formatted text" : "Plain text", (x) => {
                  if (on) x.rich = {};
                  else {
                    x.text = plainText(x.text);
                    delete x.rich;
                  }
                })
              }
              aria-label="Formatted text"
            />
            Formatted
          </label>
        }
      >
        {rich && editable && (
          <div className="flex flex-wrap gap-0.5" role="toolbar" aria-label="Text formatting">
            {tools.map((x) => (
              <Tip key={x.tip} content={x.tip}>
                <Button size="icon-sm" variant="ghost" aria-label={x.tip} onMouseDown={(e) => e.preventDefault()} onClick={x.run}>
                  {x.icon}
                </Button>
              </Tip>
            ))}
          </div>
        )}
        <Textarea
          ref={ta}
          value={v}
          disabled={!editable}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => v !== t.text && upd("Edit text", (x) => (x.text = v))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (!rich) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") (e.preventDefault(), wrap("**"));
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") (e.preventDefault(), wrap("*"));
            // Enter continues a list; Tab / Shift+Tab indent
            if (e.key === "Enter" && !e.shiftKey) {
              const el = e.currentTarget;
              const before = el.value.slice(0, el.selectionStart);
              const cur = before.slice(before.lastIndexOf("\n") + 1);
              const m = LIST_RE.exec(cur);
              if (m) {
                e.preventDefault();
                if (cur.trim() === m[0].trim()) {
                  // empty item: end the list
                  const text = before.slice(0, before.length - cur.length) + el.value.slice(el.selectionStart);
                  setV(text);
                  return;
                }
                const n = /^\d+/.test(m[2]) ? `${parseInt(m[2], 10) + 1}${m[2].slice(-1)}` : m[2];
                const ins = `\n${m[1]}${n} `;
                const pos = el.selectionStart + ins.length;
                setV(before + ins + el.value.slice(el.selectionEnd));
                requestAnimationFrame(() => el.setSelectionRange(pos, pos));
              }
            }
            if (e.key === "Tab") {
              e.preventDefault();
              lines(e.shiftKey ? "Outdent" : "Indent", (l) => (e.shiftKey ? l.replace(/^ {1,2}/, "") : "  " + l));
            }
          }}
          rows={Math.min(14, Math.max(4, v.split("\n").length + 1))}
          className={cn(rich && "font-mono text-[11px]")}
          aria-label="Text"
        />
        {rich && <p className="text-2xs text-subtle">- bullet · 1. numbered · # heading · **bold** · *italic* · --- line · Tab indents</p>}
        <Row label="Style role">
          <NativeSelect value={t.role} disabled={!editable} onChange={(e) => upd("Text role", (x) => (x.role = e.target.value as TextRole))}>
            {TEXT_ROLES.map((r2) => (
              <option key={r2} value={r2}>
                {ROLE_LABELS[r2]}
              </option>
            ))}
          </NativeSelect>
        </Row>
      </Section>
      {rich && (
        <Section title="Paragraph">
          <Row label="Align">
            <div className="flex gap-0.5">
              {(["left", "center", "right", "justify"] as const).map((a) => (
                <Button key={a} size="icon-sm" variant={(r.align ?? eff.align ?? "left") === a ? "secondary" : "ghost"} disabled={!editable} onClick={() => setRich("Text alignment", { align: a })} aria-label={`Align ${a}`}>
                  {a === "left" ? <AlignLeft /> : a === "center" ? <AlignCenter /> : a === "right" ? <AlignRight /> : <AlignJustify />}
                </Button>
              ))}
            </div>
          </Row>
          <Row label="Line spacing">
            <NativeSelect value={String(r.lineHeight ?? eff.lineHeight)} disabled={!editable} onChange={(e) => setRich("Line spacing", { lineHeight: Number(e.target.value) })} aria-label="Line spacing">
              {[1, 1.15, 1.25, 1.5, 1.75, 2].map((x) => (
                <option key={x} value={x}>
                  {x}×
                </option>
              ))}
              {![1, 1.15, 1.25, 1.5, 1.75, 2].includes(r.lineHeight ?? eff.lineHeight) && <option value={r.lineHeight ?? eff.lineHeight}>{r.lineHeight ?? eff.lineHeight}×</option>}
            </NativeSelect>
          </Row>
          <Row label="Paragraph gap">
            <NativeSelect value={String(r.paraGap ?? 0)} disabled={!editable} onChange={(e) => setRich("Paragraph spacing", { paraGap: Number(e.target.value) })} aria-label="Paragraph spacing">
              {[0, 2, 3, 4, 6, 8, 12].map((x) => (
                <option key={x} value={x}>
                  {x} pt
                </option>
              ))}
            </NativeSelect>
          </Row>
          <Row label="Wrap width" hint={r.width ? undefined : "No wrapping: lines are as typed"}>
            <div className="flex items-center gap-1">
              <Commit type="number" min={0} step={10} value={r.width ?? 0} disabled={!editable} onCommit={(x) => setRich("Wrap width", { width: Math.max(0, Number(x) || 0) })} aria-label="Wrap width" />
              <span className="text-2xs text-subtle">px</span>
            </div>
          </Row>
        </Section>
      )}
      {rich && (
        <Section title="Box">
          <Row label="Border">
            <div className="flex items-center gap-2">
              <Switch checked={!!r.border} disabled={!editable} onCheckedChange={(on) => setRich("Text border", { border: on ? { color: "#000000", width: 1 } : null })} aria-label="Border" />
              {r.border && <ColorInput value={r.border.color} disabled={!editable} onChange={(c) => setRich("Border color", { border: { ...r.border!, color: c } })} />}
              {r.border && (
                <NativeSelect value={String(r.border.width)} disabled={!editable} onChange={(e) => setRich("Border width", { border: { ...r.border!, width: Number(e.target.value) } })} aria-label="Border width" className="w-16">
                  {[0.5, 1, 1.5, 2, 3].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
          </Row>
          <Row label="Background">
            <div className="flex items-center gap-2">
              <Switch checked={!!r.background} disabled={!editable} onCheckedChange={(on) => setRich("Text background", { background: on ? "#f3f4f6" : null })} aria-label="Background" />
              {r.background && <ColorInput value={r.background} disabled={!editable} onChange={(c) => setRich("Background color", { background: c })} />}
            </div>
          </Row>
          <Row label="Padding">
            <NativeSelect value={String(r.padding ?? 4)} disabled={!editable} onChange={(e) => setRich("Text padding", { padding: Number(e.target.value) })} aria-label="Padding">
              {[0, 2, 4, 6, 8, 12, 16].map((x) => (
                <option key={x} value={x}>
                  {x} px
                </option>
              ))}
            </NativeSelect>
          </Row>
        </Section>
      )}
      <Section title="Character" actions={<Overridden on={!!t.override} onReset={() => upd("Reset text style", (x) => (x.override = undefined))} />}>
        <Row label="Size (pt)">
          <Commit type="number" step={0.5} value={eff.size} disabled={!editable} onCommit={(x) => upd("Text size", (y) => (y.override = { ...(y.override ?? {}), size: Number(x) || eff.size }))} />
        </Row>
        <Row label="Font">
          <NativeSelect value={eff.font} disabled={!editable} onChange={(e) => upd("Text font", (y) => (y.override = { ...(y.override ?? {}), font: e.target.value }))} aria-label="Font">
            {[...new Set([eff.font, "Arial, sans-serif", "Helvetica, Arial, sans-serif", "ISOCPEUR, Arial, sans-serif", "Georgia, serif", "Courier New, monospace"])].map((f) => (
              <option key={f} value={f}>
                {f.split(",")[0]}
              </option>
            ))}
          </NativeSelect>
        </Row>
        <Row label="Color">
          <ColorInput value={eff.color} disabled={!editable} onChange={(c) => upd("Text color", (y) => (y.override = { ...(y.override ?? {}), color: c }))} />
        </Row>
        <Row label="Weight">
          <div className="flex items-center gap-1">
            <NativeSelect value={eff.weight} disabled={!editable} onChange={(e) => upd("Text weight", (y) => (y.override = { ...(y.override ?? {}), weight: Number(e.target.value) }))}>
              <option value={400}>Regular</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
            </NativeSelect>
            <Button size="icon-sm" variant={eff.italic ? "secondary" : "ghost"} disabled={!editable} onClick={() => upd("Italic", (y) => (y.override = { ...(y.override ?? {}), italic: !eff.italic }))} aria-label="Italic">
              <Type className="-skew-x-12" />
            </Button>
          </div>
        </Row>
        <Row label="Rotation">
          <NativeSelect value={eff.rotation} disabled={!editable} onChange={(e) => upd("Text rotation", (y) => (y.override = { ...(y.override ?? {}), rotation: Number(e.target.value) }))}>
            {[0, 90, 180, 270].map((x) => (
              <option key={x} value={x}>
                {x}°
              </option>
            ))}
          </NativeSelect>
        </Row>
      </Section>
    </div>
  );
}
