import NextAuth, { type NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { syncUserOnSignIn } from "@/lib/membership";

const devLogin = process.env.AUTH_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
const sessionHours = Number(process.env.SESSION_HOURS ?? 12);

declare module "next-auth" {
  interface Session {
    uid: string;
    authTime: number;
  }
}

type Tok = { uid?: string; authTime?: number; denied?: string };

const providers: NextAuthConfig["providers"] = [];
if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID) {
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: { params: { scope: "openid profile email User.Read" } },
      // Skip the default profile-photo fetch: keeps the JWT small.
      async profile(p) {
        return { id: p.oid ?? p.sub, name: p.name, email: p.email ?? p.preferred_username };
      },
    }),
  );
}
if (devLogin) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Development login",
      credentials: { email: { label: "Email" }, name: { label: "Name" } },
      async authorize(c) {
        const email = String(c?.email ?? "").trim().toLowerCase();
        if (!email) return null;
        return { id: `dev:${email}`, email, name: String(c?.name || email.split("@")[0]) };
      },
    }),
  );
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  providers,
  session: { strategy: "jwt", maxAge: sessionHours * 3600 },
  pages: { signIn: "/login", signOut: "/logout", error: "/login" },
  callbacks: {
    async signIn({ user, account, profile }) {
      const p = (profile ?? {}) as Record<string, unknown>;
      const res = await syncUserOnSignIn({
        email: String(user.email ?? p.preferred_username ?? "").toLowerCase(),
        name: String(user.name ?? p.name ?? user.email ?? "User"),
        oid: account?.provider === "microsoft-entra-id" ? String(p.oid ?? user.id ?? "") : null,
        groups: Array.isArray(p.groups) ? (p.groups as string[]) : [],
        isGuest: p.acct === 1 || String(user.email ?? "").includes("#EXT#"),
      });
      if (!res.ok) return `/login?error=${encodeURIComponent(res.reason)}`;
      (user as { uid?: string }).uid = res.userId;
      return true;
    },
    async jwt({ token, user, account }) {
      const t = token as typeof token & Tok;
      if (account && user) {
        t.uid = (user as { uid?: string }).uid;
        t.authTime = Date.now();
      }
      return t;
    },
    async session({ session, token }) {
      const t = token as Tok;
      session.uid = t.uid ?? "";
      session.authTime = t.authTime ?? 0;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      const uid = (user as { uid?: string }).uid;
      if (uid) await db.auditEvent.create({ data: { actorId: uid, type: "auth.login", data: "{}" } }).catch(() => {});
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
export const DEV_LOGIN = devLogin;
export const ENTRA_ENABLED = !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
