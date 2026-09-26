import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const db = g.prisma ?? new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
if (process.env.NODE_ENV !== "production") g.prisma = db;

let pragmasApplied = false;
/** WAL + busy timeout: better concurrency for SQLite under a web server. */
export async function ensurePragmas() {
  if (pragmasApplied) return;
  pragmasApplied = true;
  try {
    await db.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await db.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
    await db.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
  } catch {
    /* ignore */
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
