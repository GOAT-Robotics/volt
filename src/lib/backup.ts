import "server-only";
/**
 * Database backups to S3.
 *
 * Everything Volt stores is in one SQLite file (projects, versions, drawings, library, comments,
 * signatures, attachments). A backup is a consistent snapshot taken with `VACUUM INTO` (safe while
 * the app keeps writing), gzip-compressed and uploaded with multipart streaming, so memory stays
 * small whatever the database size. Old backups are removed after BACKUP_KEEP_DAYS (the newest
 * few are always kept).
 *
 * Configuration (env):
 *   BACKUP_S3_BUCKET        bucket name (backups are off without it)
 *   BACKUP_S3_PREFIX        key prefix, default "volt/"
 *   BACKUP_S3_REGION        default AWS_REGION
 *   BACKUP_INTERVAL_HOURS   default 6
 *   BACKUP_KEEP_DAYS        default 30
 *   BACKUP_S3_KMS_KEY_ID    optional: SSE-KMS key (default SSE-S3 AES256)
 *   BACKUP_INCLUDE_SIGNING_KEY=1  also upload the signing key file (off by default)
 *   BACKUP_S3_ENDPOINT      optional: S3-compatible storage (MinIO, Cloudflare R2, …)
 * Credentials: the standard AWS chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or an instance role).
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createGzip } from "node:zlib";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { db } from "./db";

export function backupConfig() {
  const bucket = process.env.BACKUP_S3_BUCKET?.trim() || null;
  let prefix = (process.env.BACKUP_S3_PREFIX ?? "volt/").trim();
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    enabled: !!bucket,
    bucket,
    prefix,
    region: process.env.BACKUP_S3_REGION || process.env.AWS_REGION || "us-east-1",
    intervalHours: Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 6),
    keepDays: Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 30),
    kmsKeyId: process.env.BACKUP_S3_KMS_KEY_ID || null,
    includeSigningKey: process.env.BACKUP_INCLUDE_SIGNING_KEY === "1",
    endpoint: process.env.BACKUP_S3_ENDPOINT || null,
  };
}

const dataDir = () => process.env.DATA_DIR || path.join(process.cwd(), "data");
/** always keep at least this many backups, however old */
const KEEP_MIN = 7;

let running: Promise<BackupResult> | null = null;
export type BackupResult = { ok: boolean; key?: string; bytes?: number; error?: string; id: string };

/** Runs one backup (only one at a time; a second call joins the running one). */
export function runBackup(trigger: "SCHEDULE" | "MANUAL"): Promise<BackupResult> {
  running ??= doBackup(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function doBackup(trigger: "SCHEDULE" | "MANUAL"): Promise<BackupResult> {
  const cfg = backupConfig();
  const run = await db.backupRun.create({ data: { trigger, status: "RUNNING" } });
  const dir = path.join(dataDir(), ".backup");
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const snap = path.join(dir, `volt-${stamp}.db`);
  try {
    if (!cfg.bucket) throw new Error("BACKUP_S3_BUCKET is not set");
    await mkdir(dir, { recursive: true });
    // consistent snapshot of the live database (readers and writers keep going meanwhile)
    await db.$executeRawUnsafe(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const size = (await stat(snap)).size;
    const key = `${cfg.prefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/volt-${stamp}.db.gz`;
    const s3 = new S3Client({ region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}) });
    const sse = cfg.kmsKeyId ? { ServerSideEncryption: "aws:kms" as ServerSideEncryption, SSEKMSKeyId: cfg.kmsKeyId } : { ServerSideEncryption: "AES256" as ServerSideEncryption };
    // stream: snapshot → gzip → S3 (multipart), hashing the uncompressed snapshot on the way
    const hash = createHash("sha256");
    const body = new PassThrough();
    const src = createReadStream(snap);
    src.on("data", (c) => hash.update(c));
    const upload = new Upload({
      client: s3,
      params: { Bucket: cfg.bucket, Key: key, Body: body, ContentType: "application/gzip", ...sse, Metadata: { "volt-db-bytes": String(size), "volt-trigger": trigger } },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
    });
    const [, done] = await Promise.all([pipeline(src, createGzip({ level: 6 }), body), upload.done()]);
    const sha256 = hash.digest("hex");
    // a small manifest next to it: what the file is and how to check it
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: `${key}.json`,
        Body: JSON.stringify({ app: "volt", createdAt: now.toISOString(), trigger, dbBytes: size, sha256OfUncompressedDb: sha256, restore: "gunzip, stop Volt, replace data/volt.db (delete volt.db-wal and volt.db-shm), start Volt" }, null, 2),
        ContentType: "application/json",
        ...sse,
      }),
    );
    if (cfg.includeSigningKey) {
      const pem = await readFile(path.join(dataDir(), "signing-key.pem")).catch(() => null);
      if (pem) await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: `${cfg.prefix}signing-key.pem`, Body: pem, ContentType: "application/x-pem-file", ...sse }));
    }
    await prune(s3, cfg).catch((e) => console.error("[backup] prune", e));
    await db.backupRun.update({ where: { id: run.id }, data: { status: "OK", finishedAt: new Date(), key: (done as { Key?: string }).Key ?? key, bytes: size, sha256 } });
    console.log(`[backup] ${key} (${Math.round(size / 1048576)} MB)`);
    return { ok: true, key, bytes: size, id: run.id };
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    console.error("[backup] failed:", error);
    await db.backupRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error } }).catch(() => {});
    return { ok: false, error, id: run.id };
  } finally {
    await rm(snap, { force: true }).catch(() => {});
  }
}

/** Deletes backups older than keepDays, always keeping the newest KEEP_MIN. */
async function prune(s3: S3Client, cfg: ReturnType<typeof backupConfig>) {
  const all: { Key: string; LastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket!, Prefix: cfg.prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key && o.LastModified && /\/volt-[^/]+\.db\.gz$/.test(o.Key)) all.push({ Key: o.Key, LastModified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  all.sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime());
  const cutoff = Date.now() - cfg.keepDays * 86400_000;
  const old = all.slice(KEEP_MIN).filter((o) => o.LastModified.getTime() < cutoff);
  for (let i = 0; i < old.length; i += 500) {
    const keys = old.slice(i, i + 500).flatMap((o) => [{ Key: o.Key }, { Key: `${o.Key}.json` }]);
    await s3.send(new DeleteObjectsCommand({ Bucket: cfg.bucket!, Delete: { Objects: keys, Quiet: true } }));
  }
}

/** Background schedule: checks every 10 minutes whether a backup is due. */
export function startBackupSchedule() {
  const cfg = backupConfig();
  if (!cfg.enabled) {
    console.log("[backup] off (set BACKUP_S3_BUCKET to back up the database to S3)");
    return;
  }
  const tick = async () => {
    try {
      // a run left RUNNING by a restart is not running any more
      await db.backupRun.updateMany({ where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 3 * 3600_000) } }, data: { status: "FAILED", error: "Interrupted" } });
      const last = await db.backupRun.findFirst({ where: { status: "OK" }, orderBy: { startedAt: "desc" } });
      const lastTry = await db.backupRun.findFirst({ orderBy: { startedAt: "desc" } });
      const due = !last || Date.now() - last.startedAt.getTime() >= cfg.intervalHours * 3600_000;
      // after a failure, retry at most every 30 minutes
      const cooling = lastTry?.status === "FAILED" && Date.now() - lastTry.startedAt.getTime() < 30 * 60_000;
      if (due && !cooling) await runBackup("SCHEDULE");
    } catch (e) {
      console.error("[backup] schedule", e);
    }
  };
  setTimeout(tick, 2 * 60_000);
  setInterval(tick, 10 * 60_000).unref?.();
  console.log(`[backup] every ${cfg.intervalHours} h to s3://${cfg.bucket}/${cfg.prefix} (kept ${cfg.keepDays} days)`);
}

/** status for Administration */
export async function backupStatus() {
  const cfg = backupConfig();
  const runs = await db.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  const lastOk = await db.backupRun.findFirst({ where: { status: "OK" }, orderBy: { startedAt: "desc" } });
  return {
    config: { enabled: cfg.enabled, bucket: cfg.bucket, prefix: cfg.prefix, region: cfg.region, intervalHours: cfg.intervalHours, keepDays: cfg.keepDays, encryption: cfg.kmsKeyId ? "SSE-KMS" : "SSE-S3", includeSigningKey: cfg.includeSigningKey },
    lastOk: lastOk ? { at: lastOk.startedAt.toISOString(), key: lastOk.key, bytes: lastOk.bytes } : null,
    running: !!running,
    runs: runs.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, key: r.key, bytes: r.bytes, sha256: r.sha256, error: r.error })),
  };
}
