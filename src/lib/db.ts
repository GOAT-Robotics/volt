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
