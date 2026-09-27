import { ogResponse } from "@/lib/og/respond";
import { projectCardPng } from "@/lib/og/preview";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ogResponse(req, () => projectCardPng(id));
}
