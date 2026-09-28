/**
 * Live collaboration operations.
 *
 * Array indices are not stable when several people edit at once, so a change is described by
 * diffing the document before and after it into id-addressed operations:
 *   - arrays of objects with an `id` (pages, elements, wires, junctions, texts, shapes, cables …)
 *     are addressed by id: ["pages", {id:"p1"}, "elements", {id:"e7"}, "x"];
 *   - a change inside any other array (wire points, symbol primitives …) becomes a set of that
 *     whole array — last writer wins at that granularity.
 * Operations: set / unset a property, insert or delete an object in an id array.
 * Applying an operation whose target no longer exists (deleted by someone else) is a no-op.
 */

export type Seg = string | { id: string };
export type LiveOp =
  | { t: "set"; path: Seg[]; value: unknown }
  | { t: "unset"; path: Seg[] }
  | { t: "ins"; path: Seg[]; item: { id: string }; after: string | null }
  | { t: "del"; path: Seg[]; id: string };

type Obj = Record<string, unknown>;
const isIdItem = (v: unknown): v is { id: string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Obj).id === "string";
const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function getAt(root: unknown, path: Seg[]): unknown {
  let n: unknown = root;
  for (const s of path) {
    if (n == null) return undefined;
    if (typeof s === "string") n = (n as Obj)[s];
    else n = Array.isArray(n) ? n.find((x) => isIdItem(x) && x.id === s.id) : undefined;
  }
  return n;
}

const key = (p: Seg[]) => p.map((s) => (typeof s === "string" ? s : "#" + s.id)).join("/");
const isPlainObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isIdArray = (a: unknown[], b: unknown[]) => (a.length > 0 || b.length > 0) && a.every(isIdItem) && b.every(isIdItem);

/**
 * Operations that turn `prev` into `next`. Immer shares every unchanged subtree between the two
 * documents, so only the changed branches are visited (reference inequality).
 */
export function diffOps(prev: unknown, next: unknown, path: Seg[] = [], out: LiveOp[] = []): LiveOp[] {
  if (prev === next) return out;
  if (Array.isArray(prev) && Array.isArray(next) && isIdArray(prev, next)) {
    diffIdArray(prev as { id: string }[], next as { id: string }[], path, out);
    return out;
  }
  if (isPlainObj(prev) && isPlainObj(next) && path.length) {
    for (const k of Object.keys(prev)) if (!(k in next) || next[k] === undefined) prev[k] !== undefined && out.push({ t: "unset", path: [...path, k] });
    for (const k of Object.keys(next)) {
      if (next[k] === undefined) continue;
      if (!(k in prev) || prev[k] === undefined) out.push({ t: "set", path: [...path, k], value: clone(next[k]) });
      else diffOps(prev[k], next[k], [...path, k], out);
    }
    return out;
  }
  if (isPlainObj(prev) && isPlainObj(next)) {
    // the document root
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (next[k] === undefined) prev[k] !== undefined && out.push({ t: "unset", path: [k] });
      else if (prev[k] === undefined) out.push({ t: "set", path: [k], value: clone(next[k]) });
      else diffOps(prev[k], next[k], [k], out);
    }
    return out;
  }
  if (!path.length) return out;
  // scalars, plain arrays, or a change of type: set the whole value
  if (JSON.stringify(prev) !== JSON.stringify(next)) out.push(next === undefined ? { t: "unset", path } : { t: "set", path, value: clone(next) });
  return out;
}

function diffIdArray(prev: { id: string }[], next: { id: string }[], path: Seg[], out: LiveOp[]) {
  const pIdx = new Map(prev.map((x, i) => [x.id, i]));
  const nIds = new Set(next.map((x) => x.id));
  for (const x of prev) if (!nIds.has(x.id)) out.push({ t: "del", path, id: x.id });
  // common items keep their relative order unless moved; a moved item is deleted and re-inserted
  const common = next.filter((x) => pIdx.has(x.id)).map((x) => x.id);
  const prevCommon = prev.filter((x) => nIds.has(x.id)).map((x) => x.id);
  const moved = new Set<string>();
  if (common.join("\u0000") !== prevCommon.join("\u0000")) {
    // keep the longest run already in order (by previous index), move the rest
    const idx = common.map((id) => pIdx.get(id)!);
    const lis = longestIncreasing(idx);
    common.forEach((id, i) => !lis.has(i) && moved.add(id));
  }
  let before: string | null = null;
  for (const x of next) {
    const p = pIdx.has(x.id) ? prev[pIdx.get(x.id)!] : undefined;
    if (!p || moved.has(x.id)) {
      if (p) out.push({ t: "del", path, id: x.id });
      out.push({ t: "ins", path, item: clone(x), after: before });
    } else if (p !== x) diffOps(p, x, [...path, { id: x.id }], out);
    before = x.id;
  }
}

/** indices (into `a`) of one longest strictly increasing subsequence */
function longestIncreasing(a: number[]): Set<number> {
  const tails: number[] = [], prevOf = new Array<number>(a.length).fill(-1);
  for (let i = 0; i < a.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[tails[m]] < a[i]) lo = m + 1;
      else hi = m;
    }
    if (lo > 0) prevOf[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prevOf[i]) keep.add(i);
  return keep;
}

/** Resolve the container of the last segment; null when any step is missing. */
function parentOf(root: unknown, path: Seg[]): { parent: unknown; last: Seg } | null {
  if (!path.length) return null;
  const parent = getAt(root, path.slice(0, -1));
  if (parent == null || typeof parent !== "object") return null;
  return { parent, last: path[path.length - 1] };
}

/** Apply operations in place (on an Immer draft or a plain object). Missing targets are skipped. */
export function applyOps(root: unknown, ops: LiveOp[]): void {
  for (const o of ops) {
    if (o.t === "ins" || o.t === "del") {
      const arr = getAt(root, o.path);
      if (!Array.isArray(arr)) continue;
      const id = o.t === "ins" ? o.item.id : o.id;
      const at = arr.findIndex((x) => isIdItem(x) && x.id === id);
      if (o.t === "del") {
        if (at >= 0) arr.splice(at, 1);
        continue;
      }
      if (at >= 0) {
        arr[at] = clone(o.item);
        continue;
      }
      const ai = o.after === null ? -1 : arr.findIndex((x) => isIdItem(x) && x.id === o.after);
      if (o.after !== null && ai < 0) arr.push(clone(o.item));
      else arr.splice(ai + 1, 0, clone(o.item));
      continue;
    }
    const r = parentOf(root, o.path);
    if (!r) continue;
    if (typeof r.last === "string") {
      if (Array.isArray(r.parent)) continue;
      if (o.t === "unset") delete (r.parent as Obj)[r.last];
      else (r.parent as Obj)[r.last] = clone(o.value);
    } else {
      // whole object in an id array
      if (!Array.isArray(r.parent)) continue;
      const lastSeg = r.last;
      const at = r.parent.findIndex((x) => isIdItem(x) && x.id === lastSeg.id);
      if (at < 0) continue;
      if (o.t === "unset") r.parent.splice(at, 1);
      else r.parent[at] = clone(o.value);
    }
  }
}

/** Keys a pending local op protects: a remote set / unset on the same path, above it or inside it is ignored until ours is acknowledged. */
export function opKey(o: LiveOp): string {
  return o.t === "ins" ? key([...o.path, { id: o.item.id }]) : o.t === "del" ? key([...o.path, { id: o.id }]) : key(o.path);
}
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
