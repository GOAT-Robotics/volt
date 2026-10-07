import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { baseUrl } from "./access";
import { escHtml, mailConfigured, sendMail } from "./mail";

/**
 * One-time sign-in links for external partners. Only the SHA-256 of the token is stored; a link
 * works once, for a limited time, and only while the account is enabled and its access has not
 * ended. Opening a link shows a confirmation page — the token is used by the button, not the GET,
 * so mail scanners that open links cannot spend it.
 */
export const INVITE_TTL_H = 7 * 24;
export const LOGIN_TTL_MIN = 15;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createLoginLink(userId: string, purpose: "invite" | "login", createdById: string | null, req?: Request): Promise<{ url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (purpose === "invite" ? INVITE_TTL_H * 3600_000 : LOGIN_TTL_MIN * 60_000));
  // a new link replaces older unused ones of the same user
  await db.loginToken.deleteMany({ where: { userId, usedAt: null } });
  await db.loginToken.create({ data: { userId, tokenHash: hash(token), purpose, expiresAt, createdById } });
  return { url: `${baseUrl(req)}/login/link?token=${token}`, expiresAt };
}

export type TokenCheck = { ok: true; user: { id: string; email: string; name: string } } | { ok: false; reason: "invalid" | "used" | "expired" | "disabled" | "ended" };

/** checks a token without spending it (the confirmation page) */
export async function peekToken(token: string): Promise<TokenCheck> {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return { ok: false, reason: "invalid" };
  const t = await db.loginToken.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } });
  if (!t) return { ok: false, reason: "invalid" };
  if (t.usedAt) return { ok: false, reason: "used" };
  if (t.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (t.user.disabled || !t.user.external) return { ok: false, reason: "disabled" };
  if (t.user.accessUntil && t.user.accessUntil.getTime() < Date.now()) return { ok: false, reason: "ended" };
  return { ok: true, user: { id: t.user.id, email: t.user.email, name: t.user.name } };
}

/** spends a token (sign-in); atomic, so a token can sign in only once */
export async function consumeToken(token: string): Promise<TokenCheck> {
  const c = await peekToken(token);
  if (!c.ok) return c;
  const n = await db.loginToken.updateMany({ where: { tokenHash: hash(token), usedAt: null }, data: { usedAt: new Date() } });
  if (n.count !== 1) return { ok: false, reason: "used" };
  await db.user.update({ where: { id: c.user.id }, data: { lastLoginAt: new Date() } });
  return c;
}

/** emails a sign-in link; false when no mail transport is configured or sending failed */
export async function mailLoginLink(to: { email: string; name: string }, url: string, expiresAt: Date, o: { workspace: string; invitedBy?: string; projects?: string[] }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const until = expiresAt.toUTCString().replace(" GMT", " UTC");
  const intro = o.invitedBy ? `${o.invitedBy} invited you to ${o.workspace} on Volt` : `Your sign-in link for ${o.workspace} on Volt`;
  const projects = o.projects?.length ? `\n\nProjects: ${o.projects.join(", ")}` : "";
  const text = `Hello ${to.name},\n\n${intro}.${projects}\n\nSign in (no password needed):\n${url}\n\nThe link works once and until ${until}. If you did not expect this email, ignore it.`;
  const html = `<p>Hello ${escHtml(to.name)},</p><p>${escHtml(intro)}.</p>${o.projects?.length ? `<p>Projects: ${o.projects.map(escHtml).join(", ")}</p>` : ""}<p><a href="${escHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2f5bea;color:#fff;border-radius:6px;text-decoration:none">Sign in to Volt</a></p><p style="color:#666;font-size:12px">No password needed. The link works once and until ${escHtml(until)}. If you did not expect this email, ignore it.</p>`;
  return sendMail({ to: to.email, subject: o.invitedBy ? `${o.invitedBy} invited you to ${o.workspace} on Volt` : `Sign in to ${o.workspace} on Volt`, text, html });
}
