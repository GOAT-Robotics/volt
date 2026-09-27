import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { assertAdmin } from "@/lib/access";
import { audit } from "@/lib/audit";
import { backupConfig, backupStatus, runBackup } from "@/lib/backup";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  return backupStatus();
});

/** Back up now (waits for the upload; a scheduled run already in progress is joined). */
export const POST = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  rateLimit(`backup:${ctx.user.id}`, 3, 10 * 60_000);
  if (!backupConfig().enabled) throw new HttpError(409, "Backups are not configured (set BACKUP_S3_BUCKET)");
  const r = await runBackup("MANUAL");
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.backup", data: { ok: r.ok, key: r.key ?? null, error: r.error ?? null } });
  if (!r.ok) throw new HttpError(502, `Backup failed: ${r.error}`);
  return r;
});
