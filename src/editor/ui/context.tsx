"use client";
import { createContext, useContext } from "react";
import type { Engine } from "../engine/Engine";

export type EditorUI = {
  engine: React.RefObject<Engine | null>;
  openDialog(d: DialogName, arg?: unknown): void;
  toast(msg: string, opts?: { undo?: boolean; tone?: "error" | "success" }): void;
  announce(msg: string): void;
  saveNow(): Promise<void>;
};

export type DialogName =
  | "styles"
  | "numbering"
  | "export"
  | "compat"
  | "page"
  | "block"
  | "connect"
  | "palette"
  | "shortcuts"
  | "newVersion"
  | "submit"
  | "compare"
  | "projectProps"
  | "createElement"
  | "wiring"
  | "titleBlock";

export const EditorCtx = createContext<EditorUI | null>(null);
export function useEditorUI() {
  const c = useContext(EditorCtx);
  if (!c) throw new Error("EditorCtx missing");
  return c;
}
