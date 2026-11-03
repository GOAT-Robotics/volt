import { escHtml, mailConfigured, sendMail } from "./mail";
import { db } from "./db";
import { parseSettings } from "./settings";

export type NotifyType =
  | "review.assigned"
  | "comment.mention"
  | "review.changes"
  | "review.approved"
  | "review.rejected"
  | "signature.requested"
  | "version.released"
  | "version.superseded"
  | "library.approval"
  | "ai.review"
  | "version.recalled"
  | "variant.created"
  | "review.imported";

/** one row of the details table: label, value */
export type Detail = [string, string];

export type Notification = {
  type: NotifyType;
  title: string;
  /** one or two short sentences: shown in the app (two lines), in the email and on Teams */
  body?: string;
  /** app-relative link ("/projects/…"): the main button of the email */
  link?: string;
  workspaceId?: string;
  /** facts under the message, email and Teams only: [["Project", "P-0042 · Cobot Stand"], ["Version", "v1"]] */
  details?: Detail[];
  /** text of the main button, default "Open in Volt" */
  action?: string;
  /** further links below the button, e.g. the signed PDF; app-relative or absolute */
  links?: { label: string; href: string }[];
};

/** details rows, skipping the conditional ones: rows(["Project", name], v.ticket && ["Ticket", v.ticket]) */
export const rows = (...items: (Detail | false | null | undefined | "")[]): Detail[] => items.filter((x): x is Detail => Array.isArray(x));
/** "GR-0042 · Cobot Stand" */
export const projectLabel = (p: { number?: string | null; name: string }) => `${p.number ? `${p.number} · ` : ""}${p.name}`;
/** "v2 — Added the E-stop loop" */
export const versionLabel = (v: { label: string; summary?: string | null }) => `v${v.label}${v.summary ? ` — ${v.summary}` : ""}`;
/** "3 Nov 2026, 08:22 UTC" */
export const when = (d: Date) => `${d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
/** "10 Nov 2026" */
export const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** In-app notification + optional email + optional Teams webhook. Never throws. */
export async function notify(userIds: string[], n: Notification) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    await db.notification.createMany({ data: ids.map((userId) => ({ userId, type: n.type, title: n.title, body: n.body ?? "", link: n.link ?? null })) });
    const ws = n.workspaceId ? await db.workspace.findUnique({ where: { id: n.workspaceId } }) : null;
    const settings = parseSettings(ws?.settings);
    const base = (process.env.APP_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "");
    const org = settings.branding.name || ws?.name || "";
    const m: Mail = { ...n, base, org, links: [...(n.link ? [{ label: n.action ?? "Open in Volt", href: n.link }] : []), ...(n.links ?? [])].map((l) => ({ ...l, href: absolute(base, l.href) })) };
    if (settings.notifications.email && mailConfigured()) {
      const users = await db.user.findMany({ where: { id: { in: ids } } });
      await Promise.allSettled(users.map((u) => sendMail({ to: u.email, subject: `[Volt] ${n.title}`, text: emailText(m, u.name), html: emailHtml(m, u.name) })));
    }
    if (settings.notifications.teamsWebhook) {
      await fetch(settings.notifications.teamsWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // titles and bodies carry user text (names, comments): escape Markdown so it cannot inject links
        body: JSON.stringify({ text: teamsText(m) }),
      }).catch(() => {});
    }
  } catch (e) {
    console.error("[notify]", e);
  }
}

type Mail = Omit<Notification, "links"> & { base: string; org: string; links: { label: string; href: string }[] };

const absolute = (base: string, href: string) => (/^https?:\/\//i.test(href) ? href : base + href);

const footer = (m: Mail) => `Sent by Volt${m.org ? ` for ${m.org}` : ""}. Email notifications are switched on or off by a workspace admin under Administration › Notifications.`;

function emailText(m: Mail, name: string) {
  const details = (m.details ?? []).map(([k, v]) => `${k}: ${v}`).join("\n");
  const links = m.links.map((l, i) => (i === 0 ? `${l.label}:\n${l.href}` : `${l.label}: ${l.href}`)).join("\n\n");
  return [`Hello ${name},`, m.title, m.body, details, links, `—\n${footer(m)}`].filter(Boolean).join("\n\n");
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One column, tables and inline styles only: this has to render in Outlook. */
function emailHtml(m: Mail, name: string) {
  const [button, ...more] = m.links;
  const p = (s: string, style = "") => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#1f2937;${style}">${s}</p>`;
  const rows = (m.details ?? [])
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;font-size:13px;line-height:18px;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(k)}</td>` +
        `<td style="padding:6px 0;font-size:13px;line-height:18px;color:#1f2937;vertical-align:top">${escHtml(v)}</td></tr>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escHtml(m.title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
  <tr><td style="padding:0 4px 10px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-size:14px;font-weight:700;letter-spacing:.04em;color:#2f5bea;${FONT}">VOLT</td>
      <td align="right" style="font-size:12px;color:#6b7280;${FONT}">${escHtml(m.org)}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px 32px;${FONT}">
    ${p(`Hello ${escHtml(name)},`)}
    <h1 style="margin:0 0 14px;font-size:20px;line-height:28px;font-weight:600;color:#111827">${escHtml(m.title)}</h1>
    ${m.body ? p(escHtml(m.body).replace(/\n/g, "<br>")) : ""}
    ${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:6px 0;width:100%">${rows}</table>` : ""}
    ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 8px"><tr><td style="background:#2f5bea;border-radius:6px"><a href="${escHtml(button.href)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;${FONT}">${escHtml(button.label)}</a></td></tr></table>` : ""}
    ${more.map((l) => p(`<a href="${escHtml(l.href)}" style="color:#2f5bea;text-decoration:underline">${escHtml(l.label)}</a>`, "margin:8px 0 0;font-size:14px")).join("")}
  </td></tr>
  <tr><td style="padding:16px 4px 0;font-size:12px;line-height:18px;color:#6b7280;${FONT}">${escHtml(footer(m))}${button ? `<br><a href="${escHtml(button.href)}" style="color:#6b7280">${escHtml(button.href)}</a>` : ""}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function teamsText(m: Mail) {
  const details = (m.details ?? []).map(([k, v]) => `**${md(k)}:** ${md(v)}`).join("  \n");
  const links = m.links.map((l) => `[${md(l.label)}](${l.href})`).join(" · ");
  return [`**${md(m.title)}**`, m.body ? md(m.body) : "", details, links].filter(Boolean).join("\n\n");
}

/** Escapes Markdown for Teams message cards */
function md(s: string) {
  return s.replace(/([\\`*_{}\[\]()#+\-.!<>|~])/g, "\\$1");
}
