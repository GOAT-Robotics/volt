"use client";
/** Live session UI: who is here (avatars, click to follow), connection state, spectator mode, follow banner. */
import { Eye, EyeOff, Radio, WifiOff } from "lucide-react";
import { useEditor } from "../store";
import type { Peer } from "../live/types";
import { Tip } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

const initials = (n: string) =>
  n
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("") || "?";

/** one entry per person (several tabs of the same person show once; editing wins over viewing) */
function people(peers: Record<string, Peer>) {
  const m = new Map<string, Peer & { tabs: number }>();
  for (const p of Object.values(peers)) {
    const cur = m.get(p.userId);
    if (!cur) m.set(p.userId, { ...p, tabs: 1 });
    else m.set(p.userId, { ...(cur.mode === "view" && p.mode === "edit" ? p : cur), tabs: cur.tabs + 1 });
  }
  return [...m.values()].sort((a, b) => a.since - b.since);
}

export function LiveAvatars() {
  const peers = useEditor((s) => s.peers);
  const live = useEditor((s) => s.live);
  const following = useEditor((s) => s.following);
  const pages = useEditor((s) => s.doc.pages);
  const spectator = useEditor((s) => s.spectator);
  const editable = useEditor((s) => !!s.version?.editable);
  const set = useEditor((s) => s.set);
  if (live.status === "off") return null;
  const list = people(peers);
  const sorted = [...pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const sheetOf = (id?: string | null) => {
    const i = sorted.findIndex((p) => p.id === id);
    return i < 0 ? "" : `sheet ${i + 1} · ${sorted[i].title}`;
  };
  const shown = list.slice(0, 5);
  return (
    <div className="flex items-center gap-1.5">
      {live.status !== "live" ? (
        <Tip content="Reconnecting to the live session… your changes are kept and sent when it is back">
          <span className="flex h-6 items-center gap-1 rounded-full bg-warning-soft px-2 text-2xs font-medium text-warning">
            <WifiOff className="size-3" /> {live.status === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
        </Tip>
      ) : (
        <Tip content={list.length ? `Live — ${list.length + 1} people in this version` : "Live — changes appear for everyone instantly"}>
          <span className="flex h-6 items-center gap-1 rounded-full bg-success-soft px-2 text-2xs font-medium text-success">
            <Radio className="size-3" /> Live
          </span>
        </Tip>
      )}
      {shown.length > 0 && (
        <div className="flex -space-x-1.5">
          {shown.map((p) => {
            const on = following === p.clientId;
            return (
              <Tip key={p.userId} content={`${p.name}${p.mode === "view" ? " · viewing" : " · editing"}${sheetOf(p.pageId) ? ` · ${sheetOf(p.pageId)}` : ""} — ${on ? "click to stop following" : "click to follow"}`}>
                <button
                  onClick={() => set("following", on ? null : p.clientId)}
                  className={cn("relative flex size-7 items-center justify-center rounded-full border-2 text-[10px] font-bold text-white", on ? "z-10 ring-2 ring-offset-1 ring-offset-panel" : "border-panel hover:z-10")}
                  style={{ background: p.color, ...(on ? { borderColor: p.color, ["--tw-ring-color" as string]: p.color } : {}) }}
                  aria-label={`${p.name}, ${on ? "stop following" : "follow"}`}
                  aria-pressed={on}
                >
                  {initials(p.name)}
                  {p.mode === "view" && <Eye className="absolute -bottom-1 -right-1 size-3 rounded-full bg-panel p-px text-muted" />}
                </button>
              </Tip>
            );
          })}
          {list.length > shown.length && <span className="flex size-7 items-center justify-center rounded-full border-2 border-panel bg-hover text-[10px] font-semibold text-muted">+{list.length - shown.length}</span>}
        </div>
      )}
      {editable && (
        <Tip content={spectator ? "Spectator mode: you only watch. Click to edit again." : "Spectator mode — just watch, never change anything by accident"}>
          <button
            onClick={() => set("spectator", !spectator)}
            className={cn("flex h-6 items-center gap-1 rounded-full px-2 text-2xs font-medium", spectator ? "bg-accent-soft text-accent" : "text-subtle hover:bg-hover")}
            aria-pressed={spectator}
          >
            {spectator ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {spectator ? "Viewing" : "View only"}
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Coloured frame and name while following someone (like Figma's observation mode). */
export function FollowBanner() {
  const following = useEditor((s) => s.following);
  const peer = useEditor((s) => (s.following ? s.peers[s.following] : undefined));
  const set = useEditor((s) => s.set);
  if (!following || !peer) return null;
  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20 border-[3px]" style={{ borderColor: peer.color }} />
      <div className="absolute left-1/2 top-0 z-30 flex -translate-x-1/2 items-center gap-2 rounded-b-lg px-3 py-1 text-2xs font-medium text-white shadow-pop" style={{ background: peer.color }}>
        Following {peer.name}
        <button className="rounded bg-white/20 px-1.5 hover:bg-white/30" onClick={() => set("following", null)}>
          Stop · Esc
        </button>
      </div>
    </>
  );
}

/** Small coloured dots for the people on a sheet (page tabs). */
export function PagePeers({ pageId }: { pageId: string }) {
  const peers = useEditor((s) => s.peers);
  const here = people(peers).filter((p) => p.pageId === pageId);
  if (!here.length) return null;
  return (
    <span className="ml-1 inline-flex -space-x-1" title={here.map((p) => p.name).join(", ")}>
      {here.slice(0, 3).map((p) => (
        <span key={p.userId} className="size-2 rounded-full ring-1 ring-panel" style={{ background: p.color }} />
      ))}
    </span>
  );
}
