import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
/** SQLite: wait up to 10 s for a lock instead of failing with SQLITE_BUSY (socket_timeout is the busy timeout) */
function datasourceUrl(): string | undefined {
  const u = process.env.DATABASE_URL;
  if (!u || !u.startsWith("file:") || /[?&]socket_timeout=/.test(u)) return u;
  return `${u}${u.includes("?") ? "&" : "?"}socket_timeout=10`;
}
export const db = g.prisma ?? new PrismaClient({ datasourceUrl: datasourceUrl(), log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
if (process.env.NODE_ENV !== "production") g.prisma = db;

let pragmasApplied = false;
/** WAL + busy timeout: better concurrency for SQLite under a web server. */
export async function ensurePragmas() {
  if (pragmasApplied) return;
  try {
    // WAL is stored in the database file, so once is enough; the rest are per connection hints
    await db.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await db.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    pragmasApplied = true;
  } catch (e) {
    console.error("[db] pragmas", e);
  }
}

/** SQLite was busy longer than the busy timeout (another write held the lock) */
export function isLockTimeout(e: unknown): boolean {
  return /Socket timeout|database is locked|SQLITE_BUSY|P1008|Operations timed out/i.test(String((e as Error)?.message ?? e));
}

/** Runs a write again when SQLite stayed locked (1 s, then 3 s later); other errors are thrown at once. */
export async function retryOnLock<T>(fn: () => Promise<T>, waits = [1000, 3000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= waits.length || !isLockTimeout(e)) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

export const J = {
  parse<T>(s: string | null | undefined, fallback: T): T {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
  str: (v: unknown) => JSON.stringify(v ?? null),
};
