"use client";
import { useEffect } from "react";
import { useEditor } from "../store";
import type { EditorUI } from "./context";
import { placeBlock } from "@/core/blocks";
import { getPage } from "@/core/ops";
import type { BlockContent, Pt } from "@/core/model";

type BlockResp = { id: string; name: string; revision: number; kind: string; content: string };

export async function fetchBlock(id: string): Promise<{ name: string; revision: number; content: BlockContent }> {
  const r = await fetch(`/api/library/elements/${id}`);
  if (!r.ok) throw new Error("Block not found");
  const j = (await r.json()) as BlockResp;
  return { name: j.name, revision: j.revision, content: JSON.parse(j.content) };
}

/** Listens for block placement requests from the canvas (click in place mode or drop). */
export function useBlockPlacement(ui: EditorUI) {
  useEffect(() => {
    const onPlace = async (e: Event) => {
      const { blockId, at } = (e as CustomEvent<{ blockId: string; at: Pt }>).detail;
      const s = useEditor.getState();
      if (!s.version?.editable) return;
      try {
        const b = await fetchBlock(blockId);
        const mode = (localStorage.getItem("volt.blockMode") as "linked" | "independent" | "derived" | null) ?? "linked";
        let sel = s.sel;
        s.apply(`Place block ${b.name}`, (d) => {
          sel = placeBlock(d, getPage(d, s.pageId), blockId, b.revision, b.name, b.content, at, mode);
        });
        useEditor.getState().setSel(sel);
        ui.toast(`Placed “${b.name}” (${mode})`, { undo: true });
      } catch (err) {
        ui.toast((err as Error).message, { tone: "error" });
      }
    };
    window.addEventListener("volt:place-block", onPlace);
    return () => window.removeEventListener("volt:place-block", onPlace);
  }, [ui]);
}
