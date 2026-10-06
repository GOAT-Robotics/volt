import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { libraryDocs } from "@/lib/documents";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  return libraryDocs(ctx, id);
});
