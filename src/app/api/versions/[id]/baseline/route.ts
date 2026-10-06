import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { baselineOf } from "@/lib/commits";

export const runtime = "nodejs";

/** the document the working copy is compared with (last commit, or where the version started) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  const b = await baselineOf(a.version);
  return { kind: b.kind, id: b.id, label: b.label, doc: b.doc };
});
