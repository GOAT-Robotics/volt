import "server-only";
import { db } from "./db";
import { parseSettings, type WorkspaceSettings } from "./settings";
import { DEFAULT_WORKSPACE_SLUG } from "./membership";
import { setBrand } from "@/core/brand";
import { logoDataUrl } from "@/core/logos";

export type Branding = WorkspaceSettings["branding"];

// on globalThis: every route bundle shares it, so saving the settings refreshes the sign-in page too
const g = globalThis as unknown as { __voltBrand?: { at: number; b: Branding } | null };

/**
 * The organization branding of the default workspace, for pages without a signed-in user (sign-in
 * page, site metadata, link previews). Cached briefly; saving the settings refreshes it.
 */
export async function orgBranding(): Promise<Branding> {
  const cache = g.__voltBrand;
  if (cache && Date.now() - cache.at < 30_000) return cache.b;
  let b: Branding = { name: "", address: "", url: "", logo: null };
  try {
    const ws = await db.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG }, select: { settings: true } });
    if (ws) b = parseSettings(ws.settings).branding;
  } catch {}
  g.__voltBrand = { at: Date.now(), b };
  return b;
}

export function forgetBranding() {
  g.__voltBrand = null;
}

/** Branding of one workspace, also made the default logo of server-side renders. */
export async function applyWorkspaceBrand(workspaceId: string): Promise<Branding> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const b = ws ? parseSettings(ws.settings).branding : { name: "", address: "", url: "", logo: null };
  setBrand(b);
  return b;
}

export const brandLogoUri = (b: Branding) => (b.logo ? logoDataUrl(b.logo) : null);
