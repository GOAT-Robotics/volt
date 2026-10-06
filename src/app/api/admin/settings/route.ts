import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { parseSettings } from "@/lib/settings";
import { liveHooks } from "@/lib/live/hooks";
import { forgetBranding } from "@/lib/brand";
import { setBrand } from "@/core/brand";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  return { settings: ctx.settings, name: ctx.workspace.name };
});

const Settings = z.object({
  guestPolicy: z.enum(["deny", "reviewOnly", "allow"]),
  sessionHours: z.number().int().min(1).max(24 * 30),
  signReauthMinutes: z.number().int().min(1).max(24 * 60),
  approval: z.object({
    minApprovals: z.number().int().min(1).max(20),
    sequentialDefault: z.boolean(),
    allowSelfApproval: z.boolean(),
    requireCommentsResolved: z.boolean(),
    approvalExpiryDays: z.number().int().min(1).max(3650).nullable(),
    signatureRequiredForRelease: z.boolean(),
    requiredSignatories: z.number().int().min(0).max(20),
    editSubmitted: z.enum(["forbid", "newVersion"]),
  }),
  signature: z.object({ provider: z.literal("builtin"), statement: z.string().trim().min(10).max(2000), expiryDays: z.number().int().min(0).max(365) }),
  exports: z.object({ viewerCanExport: z.boolean(), guestCanExport: z.boolean(), formats: z.array(z.enum(["pdf", "svg", "png", "qet", "dxf"])).min(1) }),
  retention: z.object({ archiveAfterDays: z.number().int().min(1).max(36500).nullable(), deleteAutosavesAfterDays: z.number().int().min(1).max(3650), keepAuditYears: z.number().int().min(1).max(100) }),
  notifications: z.object({ email: z.boolean(), teamsWebhook: z
      .string()
      .trim()
      .url()
      .startsWith("https://")
      // Microsoft webhook hosts only (the server posts to it: no internal addresses)
      .refine((u) => /^https:\/\/[a-z0-9.-]+\.(webhook\.office\.com|logic\.azure\.com|environment\.api\.powerplatform\.com)(:443)?\//i.test(u), "Use a Microsoft Teams / Power Automate webhook URL")
      .nullable().or(z.literal("").transform(() => null)) }),
  qetBaseline: z.string().trim().min(1).max(20),
  autosaveSeconds: z.number().int().min(1).max(600),
  library: z.object({ requireApprovalForOrg: z.boolean() }),
  versionScheme: z.enum(["INTEGER", "DECIMAL", "LETTER", "CUSTOM"]),
  linkPreviews: z.enum(["off", "name", "picture"]).default("picture"),
  collaboration: z.object({ live: z.boolean(), presence: z.boolean() }).default({ live: true, presence: true }),
  branding: z
    .object({
      name: z.string().trim().max(160),
      address: z.string().trim().max(600),
      url: z.string().trim().max(300).refine((u) => !u || /^https?:\/\//i.test(u), "Use an http(s) address").or(z.literal("")),
      logo: z.object({ type: z.enum(["png", "jpg", "svg"]), data: z.string().max(900_000).regex(/^[A-Za-z0-9+/=]*$/, "Not base64") }).nullable(),
    })
    .default({ name: "", address: "", url: "", logo: null }),
  access: z.object({ newMemberRole: z.enum(["none", "VIEWER", "DESIGNER"]), projectSharing: z.enum(["admins", "owners"]) }).default({ newMemberRole: "none", projectSharing: "admins" }),
  aiReview: z
    .object({ enabled: z.boolean(), onSubmit: z.boolean(), useModel: z.boolean(), minLevel: z.enum(["error", "warning", "info"]), instructions: z.string().max(8000) })
    .default({ enabled: true, onSubmit: true, useModel: true, minLevel: "warning", instructions: "" }),
});

export const PUT = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(120).optional(), settings: Settings }));
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: ctx.workspace.id } });
  const before = parseSettings(ws.settings);
  const merged = { ...before, ...b.settings };
  await db.workspace.update({ where: { id: ws.id }, data: { settings: JSON.stringify(merged), ...(b.name ? { name: b.name } : {}) } });
  const changed = Object.keys(b.settings).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((merged as Record<string, unknown>)[k]));
  forgetBranding();
  setBrand(merged.branding);
  // live collaboration switched off: save every open live session and move its editors to normal saving
  if (before.collaboration.live && !merged.collaboration.live) await liveHooks.disable?.(ws.id);
  await audit({ workspaceId: ws.id, actorId: ctx.user.id, type: "admin.settings", data: { changed, ...(b.name && b.name !== ws.name ? { name: b.name } : {}) } });
  return { ok: true };
});
