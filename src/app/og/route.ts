import { ogResponse } from "@/lib/og/respond";

export const runtime = "nodejs";

/** the site card (sign-in page, anything without its own preview) */
export async function GET(req: Request) {
  return ogResponse(req, async () => null);
}
