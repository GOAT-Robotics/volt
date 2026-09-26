"use client";
import dynamic from "next/dynamic";
import type { Doc } from "@/core/model";
import type { VersionInfo } from "../store";

/** The editor is a pure client application (canvas + module store): never server-render it. */
const EditorApp = dynamic(() => import("./EditorApp").then((m) => m.EditorApp), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-bg">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
        Loading editor…
      </div>
    </div>
  ),
});

export function EditorClient(props: { doc: Doc; version: VersionInfo }) {
  return <EditorApp {...props} />;
}
