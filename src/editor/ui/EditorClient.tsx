"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Doc } from "@/core/model";
import type { VersionInfo } from "../store";
import { LogoMark } from "@/components/brand/Logo";

function Loading({ label, error }: { label: string; error?: string | null }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg">
      <LogoMark size={36} className={error ? "" : "animate-pulse"} />
      {error ? (
        <div className="text-center">
          <p className="text-sm font-medium text-danger">Could not open the drawing</p>
          <p className="mt-1 text-xs text-muted">{error}</p>
          <button className="mt-3 rounded-md border border-border px-3 py-1 text-xs hover:bg-hover" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted">{label}</p>
      )}
    </div>
  );
}

/** The editor is a pure client application (canvas + module store): never server-render it. */
const EditorApp = dynamic(() => import("./EditorApp").then((m) => m.EditorApp), { ssr: false, loading: () => <Loading label="Loading editor…" /> });

/**
 * Loads the drawing as compressed JSON in parallel with the editor code (the page itself carries no
 * document, so navigation is instant even for multi-MB projects).
 */
export function EditorClient({ version }: { version: VersionInfo }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [rev, setRev] = useState(version.docRev);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // warm the editor bundle while the document downloads
    void import("./EditorApp");
    loadDoc(version.versionId)
      .then((j) => {
        if (!live) return;
        setRev(j.docRev);
        setDoc(j.doc);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [version.versionId]);
  if (!doc) return <Loading label={`Opening ${version.projectName}…`} error={error} />;
  inflight.delete(version.versionId);
  return <EditorApp doc={doc} version={{ ...version, docRev: rev }} />;
}

/** One request per open, shared by effect re-runs (it also picks up the page's preload). */
const inflight = new Map<string, Promise<{ doc: Doc; docRev: number }>>();
function loadDoc(versionId: string) {
  let p = inflight.get(versionId);
  if (!p) {
    p = fetch(`/api/versions/${versionId}/doc`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j as { doc: Doc; docRev: number };
    });
    inflight.set(versionId, p);
    p.catch(() => inflight.delete(versionId));
  }
  return p;
}
