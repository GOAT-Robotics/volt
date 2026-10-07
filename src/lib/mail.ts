import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Outgoing email: Amazon SES (SES_FROM_EMAIL, AWS_REGION) or any SMTP server (SMTP_URL, e.g.
 * smtp://user:pass@smtp.office365.com:587, with MAIL_FROM). Without either, nothing is sent and
 * callers fall back to showing the link to the admin.
 */
export function mailConfigured(): boolean {
  return process.env.SMTP_URL
    ? !!(process.env.MAIL_FROM || process.env.SES_FROM_EMAIL)
    : !!process.env.SES_FROM_EMAIL;
}

export async function sendMail(m: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
  try {
    if (process.env.SMTP_URL) {
      const nodemailer = await import("nodemailer");
      const t = nodemailer.createTransport(process.env.SMTP_URL, { disableFileAccess: true, disableUrlAccess: true });
      await t.sendMail({ from: process.env.MAIL_FROM || process.env.SES_FROM_EMAIL, to: m.to, subject: m.subject, text: m.text, html: m.html });
      return true;
    }
    if (process.env.SES_FROM_EMAIL) {
      const ses = new SESv2Client({ region: process.env.AWS_REGION ?? "us-east-1" });
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: process.env.SES_FROM_EMAIL,
          Destination: { ToAddresses: [m.to] },
          Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { Text: { Data: m.text, Charset: "UTF-8" }, ...(m.html ? { Html: { Data: m.html, Charset: "UTF-8" } } : {}) } } },
        }),
      );
      return true;
    }
  } catch (e) {
    console.error("[mail]", e);
  }
  return false;
}

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
