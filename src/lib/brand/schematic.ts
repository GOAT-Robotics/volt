/**
 * Decorative schematic line art (login background, link preview cards): a power section with
 * three-phase rails, feeders with fuses, contactors and motors, and a control ladder with contacts,
 * coils and lamps — drawn like a real IEC sheet, in one colour (currentColor).
 *
 * Deterministic for a given seed and size, returns SVG markup (no outer <svg>).
 */

type Rng = () => number;
function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => String(Math.round(n * 10) / 10);

export type SchematicOptions = {
  width: number;
  height: number;
  seed?: number;
  /** extra class on a few long wires (e.g. for an animated "current flow" overlay) */
  flowClass?: string;
  /** font for the device tags and wire numbers */
  font?: string;
  /** stroke width of wires */
  stroke?: number;
};

export function schematicArt(o: SchematicOptions): string {
  const r = rng(o.seed ?? 7);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const font = o.font ?? "Liberation Sans, Arial, Helvetica, sans-serif";
  const sw = o.stroke ?? 1.2;
  const lines: string[] = []; // wires (one path)
  const sym: string[] = []; // symbol strokes
  const fills: string[] = []; // junction dots
  const texts: string[] = [];
  const flows: string[] = [];
  const W = o.width, H = o.height;

  const tag = (x: number, y: number, t: string, anchor: "start" | "end" = "start") =>
    texts.push(`<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="10">${t}</text>`);
  const wn = (x: number, y: number, t: string) => texts.push(`<text x="${f(x)}" y="${f(y)}" font-size="8" opacity="0.8">${t}</text>`);
  const dot = (x: number, y: number) => fills.push(`M${f(x - 2.4)} ${f(y)}a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0Z`);
  const wire = (d: string) => lines.push(d);
  const V = (x: number, y1: number, y2: number) => wire(`M${f(x)} ${f(y1)}V${f(y2)}`);
  const Hh = (y: number, x1: number, x2: number) => wire(`M${f(x1)} ${f(y)}H${f(x2)}`);

  /* vertical symbols: centred on x, occupy [y, y+len], draw their own leads */
  type Sym = { len: number; draw: (x: number, y: number) => void; prefix: string };
  const fuse: Sym = { len: 40, prefix: "F", draw: (x, y) => (V(x, y, y + 8), sym.push(`M${f(x - 4.5)} ${f(y + 8)}h9v24h-9Z M${f(x)} ${f(y + 8)}V${f(y + 32)}`), V(x, y + 32, y + 40)) };
  const no: Sym = { len: 40, prefix: "K", draw: (x, y) => (V(x, y, y + 13), sym.push(`M${f(x - 9)} ${f(y + 15)}L${f(x)} ${f(y + 27)}`), V(x, y + 27, y + 40)) };
  const nc: Sym = { len: 40, prefix: "K", draw: (x, y) => (V(x, y, y + 13), sym.push(`M${f(x + 8)} ${f(y + 13)}L${f(x)} ${f(y + 27)} M${f(x)} ${f(y + 13)}H${f(x + 9)}`), V(x, y + 27, y + 40)) };
  const breaker: Sym = {
    len: 44,
    prefix: "Q",
    draw: (x, y) => (V(x, y, y + 13), sym.push(`M${f(x - 3)} ${f(y + 10)}l6 6 M${f(x + 3)} ${f(y + 10)}l-6 6 M${f(x - 10)} ${f(y + 16)}L${f(x)} ${f(y + 30)}`), V(x, y + 30, y + 44)),
  };
  const push: Sym = {
    len: 40,
    prefix: "S",
    draw: (x, y) => (V(x, y, y + 13), sym.push(`M${f(x - 9)} ${f(y + 15)}L${f(x)} ${f(y + 27)} M${f(x - 5)} ${f(y + 21)}H${f(x - 18)} M${f(x - 18)} ${f(y + 16)}V${f(y + 26)}`), V(x, y + 27, y + 40)),
  };
  const coil: Sym = { len: 36, prefix: "K", draw: (x, y) => (V(x, y, y + 11), sym.push(`M${f(x - 10)} ${f(y + 11)}h20v14h-20Z`), V(x, y + 25, y + 36)) };
  const lamp: Sym = {
    len: 36,
    prefix: "H",
    draw: (x, y) => (V(x, y, y + 8), sym.push(`M${f(x - 10)} ${f(y + 18)}a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z M${f(x - 7)} ${f(y + 11)}l14 14 M${f(x + 7)} ${f(y + 11)}l-14 14`), V(x, y + 28, y + 36)),
  };
  const res: Sym = { len: 36, prefix: "R", draw: (x, y) => (V(x, y, y + 7), sym.push(`M${f(x - 4)} ${f(y + 7)}h8v22h-8Z`), V(x, y + 29, y + 36)) };
  const diode: Sym = { len: 32, prefix: "V", draw: (x, y) => (V(x, y, y + 9), sym.push(`M${f(x - 7)} ${f(y + 9)}h14l-7 12Z M${f(x - 7)} ${f(y + 21)}h14`), V(x, y + 21, y + 32)) };
  const cap: Sym = { len: 30, prefix: "C", draw: (x, y) => (V(x, y, y + 13), sym.push(`M${f(x - 9)} ${f(y + 13)}h18 M${f(x - 9)} ${f(y + 17)}h18`), V(x, y + 17, y + 30)) };
  const term: Sym = { len: 14, prefix: "X", draw: (x, y) => (V(x, y, y + 4), sym.push(`M${f(x - 3)} ${f(y + 7)}a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z`), V(x, y + 10, y + 14)) };
  const counters: Record<string, number> = {};
  const nextTag = (p: string) => `-${p}${(counters[p] = (counters[p] ?? 0) + 1)}`;
  let wireNo = 1;

  // ── power section: L1 L2 L3 N PE across the top ─────────────────────────────
  const top = 34;
  const railGap = 16;
  const rails = ["L1", "L2", "L3", "N", "PE"];
  const railY = rails.map((_, i) => top + i * railGap);
  rails.forEach((n, i) => {
    Hh(railY[i], 40, W - 20);
    tag(14, railY[i] + 3.5, n);
  });
  if (o.flowClass) flows.push(`M40 ${f(railY[0])}H${f(W - 20)}`, `M${f(W - 20)} ${f(railY[2])}H40`);

  const powerBottom = Math.min(H * 0.5, 360);
  let x = 90;
  while (x < W - 160) {
    const kind = r();
    if (kind < 0.55) {
      // three-phase motor feeder: Q, K, (F), motor
      const xs = [x, x + 16, x + 32];
      xs.forEach((cx, i) => dot(cx, railY[i]));
      let y = railY[4] + 12;
      xs.forEach((cx, i) => V(cx, railY[i], y));
      const parts: Sym[] = [breaker, no, ...(r() < 0.5 ? [fuse] : [])];
      for (const s of parts) {
        const t = nextTag(s.prefix);
        xs.forEach((cx) => s.draw(cx, y));
        // mechanical link between the poles
        sym.push(`M${f(xs[0] - 5)} ${f(y + s.len / 2)}H${f(xs[2] - 5)}`);
        tag(xs[2] + 12, y + s.len / 2 + 3, t);
        y += s.len + 6;
        xs.forEach((cx) => V(cx, y - 6, y));
      }
      const my = Math.min(powerBottom - 30, y + 26);
      xs.forEach((cx) => V(cx, y, my - 20));
      xs.forEach((cx) => wire(`M${f(cx)} ${f(my - 20)}L${f(x + 16)} ${f(my - 15)}`));
      sym.push(`M${f(x + 16 - 18)} ${f(my)}a18 18 0 1 0 36 0a18 18 0 1 0 -36 0Z`);
      texts.push(`<text x="${f(x + 16)}" y="${f(my + 1)}" text-anchor="middle" font-size="13">M</text><text x="${f(x + 16)}" y="${f(my + 12)}" text-anchor="middle" font-size="8">3~</text>`);
      tag(x + 40, my + 4, nextTag("M"));
      // PE to the motor
      dot(x + 48, railY[4]);
      wire(`M${f(x + 48)} ${f(railY[4])}V${f(my - 8)}L${f(x + 32)} ${f(my - 8)}`);
      if (o.flowClass && r() < 0.5) flows.push(`M${f(x)} ${f(railY[0])}V${f(my - 20)}`);
      x += 110;
    } else if (kind < 0.8) {
      // single-phase outlet / supply: L, fuse, terminal pair
      dot(x, railY[0]);
      dot(x + 18, railY[3]);
      let y = railY[3] + 12;
      V(x, railY[0], y);
      V(x + 18, railY[3], y);
      const tf = nextTag("F");
      fuse.draw(x, y);
      V(x + 18, y, y + 40);
      tag(x + 26, y + 24, tf);
      y += 40;
      term.draw(x, y);
      term.draw(x + 18, y);
      tag(x + 26, y + 10, nextTag("X"));
      y += 14;
      // out to a lamp across
      V(x, y, y + 20);
      V(x + 18, y, y + 40);
      Hh(y + 20, x, x - 14);
      Hh(y + 40, x + 18, x - 14);
      V(x - 14, y + 20, y + 26);
      V(x - 14, y + 34, y + 40);
      sym.push(`M${f(x - 20)} ${f(y + 26)}h12v8h-12Z`);
      wn(x + 4, y + 16, String(wireNo++));
      x += 70;
    } else {
      // power supply 230 V AC / 24 V DC box
      dot(x, railY[0]);
      dot(x + 20, railY[3]);
      const y = railY[3] + 30;
      V(x, railY[0], y);
      V(x + 20, railY[3], y);
      sym.push(`M${f(x - 10)} ${f(y)}h40v34h-40Z M${f(x - 10)} ${f(y + 34)}L${f(x + 30)} ${f(y)}`);
      texts.push(`<text x="${f(x - 6)}" y="${f(y + 11)}" font-size="8">~</text><text x="${f(x + 18)}" y="${f(y + 30)}" font-size="8">=</text>`);
      tag(x + 36, y + 20, nextTag("G"));
      V(x, y + 34, y + 50);
      V(x + 20, y + 34, y + 50);
      term.draw(x, y + 50);
      term.draw(x + 20, y + 50);
      texts.push(`<text x="${f(x - 4)}" y="${f(y + 78)}" font-size="8" text-anchor="end">+24V</text><text x="${f(x + 24)}" y="${f(y + 78)}" font-size="8">0V</text>`);
      x += 80;
    }
  }

  // ── control ladder: +24 V on the left, 0 V on the right; rungs across ──────────
  const cTop = powerBottom + 30;
  const cBot = H - 30;
  const pL = 40, pR = W - 40;
  V(pL, cTop, cBot);
  V(pR, cTop, cBot);
  tag(pL - 6, cTop - 6, "+24V");
  tag(pR + 6, cTop - 6, "0V", "end");
  if (o.flowClass) flows.push(`M${f(pL)} ${f(cTop)}V${f(cBot)}`);
  const rungGap = 52;
  const rot = (s: Sym, cx: number, y: number) => {
    // horizontal symbol: draw vertically then rotate -90° about its start point
    const g0 = sym.length, l0 = lines.length;
    s.draw(cx, y);
    const g = [...sym.splice(g0), ...lines.splice(l0)].join(" ");
    sym.push(`<g transform="rotate(-90 ${f(cx)} ${f(y)})"><path d="${g}"/></g>`);
  };
  for (let y = cTop + 20; y < cBot - 10; y += rungGap) {
    // series elements along the rung, then a coil or lamp near the right rail
    const n = 2 + Math.floor(r() * 3);
    const items: Sym[] = [];
    for (let i = 0; i < n; i++) items.push(pick([no, no, nc, push, term, res, diode, cap, fuse]));
    items.push(pick([coil, coil, lamp]));
    const span = pR - pL - 40;
    const room = items.reduce((a, s) => a + s.len, 0);
    const gap = Math.max(20, (Math.min(span, 180 + r() * (span - 180)) - room) / (items.length + 1));
    let cx = pL + 20 + r() * Math.max(0, span - room - gap * (items.length + 1));
    dot(pL, y);
    Hh(y, pL, cx);
    const flowFrom = cx;
    for (let i = 0; i < items.length; i++) {
      const s = items[i];
      cx += gap;
      Hh(y, cx - gap, cx);
      // symbol goes rightwards: rotate(-90) turns +y into +x
      rot(s, cx, y);
      tag(cx + s.len / 2, y - 14, nextTag(s.prefix), "start");
      cx += s.len;
      if (i < items.length - 1 && r() < 0.35) {
        // a parallel branch (seal-in contact / OR) below the rung
        const bx0 = cx - s.len - 8, bx1 = bx0 + 60;
        dot(bx0, y);
        dot(bx1, y);
        V(bx0, y, y + 22);
        V(bx1, y, y + 22);
        Hh(y + 22, bx0, bx0 + 10);
        Hh(y + 22, bx1 - 10, bx1);
        rot(pick([no, nc]), bx0 + 10, y + 22);
      }
      if (r() < 0.25) wn(cx + 4, y - 3, String(wireNo++));
    }
    Hh(y, cx, pR);
    dot(pR, y);
    if (o.flowClass && r() < 0.4) flows.push(`M${f(flowFrom)} ${f(y)}H${f(pR)}`);
    // an occasional cross-connection down to the next rung ("wires going here and there")
    if (r() < 0.45 && y + rungGap < cBot - 10) {
      const jx = pL + 60 + r() * (pR - pL - 200);
      const jy = y + rungGap * (0.35 + r() * 0.3);
      dot(jx, y);
      const jx2 = jx + 40 + r() * 120;
      wire(`M${f(jx)} ${f(y)}V${f(jy)}H${f(jx2)}V${f(y + rungGap)}`);
      dot(jx2, y + rungGap);
    }
  }

  return [
    `<g fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter"><path d="${lines.join(" ")}"/></g>`,
    `<g fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round"><path d="${sym.filter((s) => !s.startsWith("<")).join(" ")}"/>${sym.filter((s) => s.startsWith("<")).join("")}</g>`,
    `<path fill="currentColor" d="${fills.join(" ")}"/>`,
    `<g fill="currentColor" font-family="${font}">${texts.join("")}</g>`,
    o.flowClass && flows.length ? `<g fill="none" stroke="currentColor" stroke-width="${sw * 1.8}" stroke-linecap="round" class="${o.flowClass}"><path d="${flows.join(" ")}"/></g>` : "",
  ].join("");
}
