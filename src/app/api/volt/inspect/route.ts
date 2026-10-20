import { rateLimit } from "@/lib/ratelimit";
import { formData, route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { inspectVolt, parseVoltUpload } from "@/lib/voltfile/import";
import { MAX_VOLT_FILE } from "@/lib/voltfile/format";

export const runtime = "nodejs";

/**
 * What a .volt file holds and what uploading it would do: integrity and seal, versions, reviews,
 * the new-project import report, and the versions here it is a reviewed copy of (merge targets).
 * Nothing is stored.
 */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`volt.inspect:${ctx.user.id}`, 30);
  const fd = await formData(req, MAX_VOLT_FILE + 1024 * 1024, "File");
  const p = await parseVoltUpload(fd.get("file"));
  return inspectVolt(ctx, p);
});
