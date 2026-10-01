/**
 * Organization branding used by the renderers: the default company logo for title block logo
 * cells and cover sheets that have none of their own, and the default manufacturer block of new
 * cover sheets. Set by the app from the workspace settings (Administration → Branding); empty by
 * default, so an unbranded installation draws no logo.
 */
import type { TitleBlockLogo } from "./model";

export type Brand = { name: string; address: string; logo: TitleBlockLogo | null };

// on globalThis so that every bundle (server routes, editor chunks) sees the same branding
const g = globalThis as unknown as { __voltBrandCurrent?: Brand };
const get = (): Brand => (g.__voltBrandCurrent ??= { name: "", address: "", logo: null });

export function setBrand(b: Partial<Brand> | null | undefined) {
  const next: Brand = { name: b?.name ?? "", address: b?.address ?? "", logo: b?.logo ?? null };
  const cur = get();
  if (next.name === cur.name && next.address === cur.address && (next.logo?.data ?? null) === (cur.logo?.data ?? null) && next.logo?.type === cur.logo?.type) return;
  g.__voltBrandCurrent = next;
}

export const brand = (): Brand => get();
/** the organization logo, or null when none is configured */
export const brandLogo = (): TitleBlockLogo | null => get().logo;
