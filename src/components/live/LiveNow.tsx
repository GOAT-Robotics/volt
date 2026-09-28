"use client";
/** "Who is working on this right now" for project lists and pages (polls the live hub). */
import { useEffect, useState } from "react";
import { Tip } from "@/components/ui/misc";

export type LivePerson = { userId: string; name: string; color: string; versionId: string; pageId: string | null; mode: "edit" | "view"; since: number };

export function useLivePeople(projectIds: string[], every = 10_000): Record<string, LivePerson[]> {
  const [data, setData] = useState<Record<string, LivePerson[]>>({});
  const key = projectIds.join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const load = () =>
      fetch(`/api/live?projects=${encodeURIComponent(key)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { projects: {} }))
        .then((j) => live && setData(j.projects ?? {}))
        .catch(() => {});
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), every);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key, every]);
  return data;
}

const initials = (n: string) =>
  n
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("") || "?";

/** Coloured avatars with a pulsing "live" dot; tooltip says who edits or watches which version. */
export function LiveStack({ people, versions, size = 22 }: { people: LivePerson[] | undefined; versions?: Record<string, string>; size?: number }) {
  if (!people?.length) return null;
  const byUser = new Map<string, LivePerson>();
  for (const p of people) {
    const cur = byUser.get(p.userId);
    if (!cur || (cur.mode === "view" && p.mode === "edit")) byUser.set(p.userId, p);
  }
  const list = [...byUser.values()];
  const text = list.map((p) => `${p.name} is ${p.mode === "edit" ? "editing" : "viewing"}${versions?.[p.versionId] ? ` v${versions[p.versionId]}` : ""}`).join("\n");
  return (
    <Tip content={<span className="whitespace-pre-line">{text}</span>}>
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
        <span className="flex -space-x-1.5">
          {list.slice(0, 4).map((p) => (
            <span key={p.userId} className="flex items-center justify-center rounded-full border-2 border-panel font-bold text-white" style={{ background: p.color, width: size, height: size, fontSize: size * 0.4 }}>
              {initials(p.name)}
            </span>
          ))}
        </span>
        {list.length > 4 && <span className="text-2xs text-muted">+{list.length - 4}</span>}
      </span>
    </Tip>
  );
}
