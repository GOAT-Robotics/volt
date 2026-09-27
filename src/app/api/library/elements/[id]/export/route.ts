import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, loadElement } from "@/lib/library/access";
import { elmtFileName } from "@/lib/library/store";
import { route } from "@/lib/api";

export const runtime = "nodejs";

/** Download a single element as a QElectroTech .elmt file (or a block as .json). */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const revParam = new URL(req.url).searchParams.get("rev");
  const want = revParam ? Number(revParam) : a.viewerRevision;
  if (!Number.isInteger(want) || want < 1) throw new HttpError(400, "Invalid revision");
  if (!a.full && want > a.viewerRevision) throw new HttpError(404, "Revision not available");
  let content = a.el.content;
  if (want !== a.el.revision) {
    const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: id, revision: want } } });
    if (!r) throw new HttpError(404, "Revision not found");
    content = r.content;
  }
  const block = a.el.kind === "BLOCK";
  const fn = block ? elmtFileName(a.el).replace(/\.elmt$/, ".volt-block.json") : elmtFileName(a.el);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.export", data: { ids: [id], revision: want, format: block ? "json" : "elmt" } });
  return new Response(content, {
    headers: {
      "content-type": block ? "application/json; charset=utf-8" : "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`,
      "cache-control": "no-store",
    },
  });
});
