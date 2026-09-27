import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
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
  | "library.approval";

/** In-app notification + optional SES email + optional Teams webhook. Never throws. */
export async function notify(userIds: string[], n: { type: NotifyType; title: string; body?: string; link?: string; workspaceId?: string }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    await db.notification.createMany({ data: ids.map((userId) => ({ userId, type: n.type, title: n.title, body: n.body ?? "", link: n.link ?? null })) });
    const ws = n.workspaceId ? await db.workspace.findUnique({ where: { id: n.workspaceId } }) : null;
    const settings = parseSettings(ws?.settings);
    const base = process.env.AUTH_URL ?? process.env.APP_URL ?? "";
    if (settings.notifications.email && process.env.SES_FROM_EMAIL) {
      const users = await db.user.findMany({ where: { id: { in: ids } } });
      const ses = new SESv2Client({ region: process.env.AWS_REGION ?? "ap-south-1" });
      const from = process.env.SES_FROM_EMAIL;
      await Promise.allSettled(
        users.map((u) =>
          ses.send(new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [u.email] },
            Content: { Simple: {
              Subject: { Data: `[Volt] ${n.title}`, Charset: "UTF-8" },
              Body: { Text: { Data: `${n.body ?? ""}\n\n${n.link ? base + n.link : ""}`, Charset: "UTF-8" } },
            } },
          })),
        ),
      );
    }
    if (settings.notifications.teamsWebhook) {
      await fetch(settings.notifications.teamsWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // titles and bodies carry user text (names, comments): escape Markdown so it cannot inject links
        body: JSON.stringify({ text: `**${md(n.title)}**\n\n${md(n.body ?? "")}${n.link ? `\n\n${base}${n.link}` : ""}` }),
      }).catch(() => {});
    }
  } catch (e) {
    console.error("[notify]", e);
  }
}

/** Escapes Markdown for Teams message cards */
function md(s: string) {
  return s.replace(/([\\`*_{}\[\]()#+\-.!<>|~])/g, "\\$1");
}
