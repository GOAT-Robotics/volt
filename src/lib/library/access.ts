import "server-only";
import type { Prisma, LibraryElement, Library } from "@prisma/client";
import { db, J } from "@/lib/db";
import { can, HttpError, type Ctx } from "@/lib/session";
import { notify } from "@/lib/notify";
import { parseRoles, rolesAllow } from "@/lib/roles";

export type Visibility = "PRIVATE" | "SHARED" | "ORG";
export type LibStatus = "DRAFT" | "PUBLISHED" | "PENDING_APPROVAL" | "APPROVED" | "DEPRECATED";
export const VISIBILITIES: Visibility[] = ["PRIVATE", "SHARED", "ORG"];
export const LIB_STATUSES: LibStatus[] = ["DRAFT", "PUBLISHED", "PENDING_APPROVAL", "APPROVED", "DEPRECATED"];

/** Hidden meta keys (never sent to clients as metadata). */
export const APPROVED_REV_KEY = "__approvedRev";
export const REJECT_KEY = "__rejectReason";

export const isAdmin = (ctx: Ctx) => ctx.roles.includes("ADMIN");
export const isApprover = (ctx: Ctx) => can(ctx, "library.approve");
export const canPublish = (ctx: Ctx) => can(ctx, "library.publish");
/** No library: guests, and people without a workspace role who were not given any project either. */
export const isGuestCtx = (ctx: Ctx) => ctx.user.isGuest || (ctx.roles.length === 1 && ctx.roles[0] === "GUEST") || (!ctx.roles.length && !ctx.projectAccess) || (ctx.user.external && !can(ctx, "library.view"));

export function assertMember(ctx: Ctx) {
  if (isGuestCtx(ctx)) throw new HttpError(403, ctx.user.isGuest ? "Guests cannot use the component library" : ctx.user.external ? "Your role does not include the component library" : "You don't have access yet — ask a workspace admin");
}

/** Statuses in which an ORG element is visible to everyone. */
export const ORG_LIVE: LibStatus[] = ["PUBLISHED", "APPROVED"];

/**
 * Prisma filter for elements the user may see in listings.
 * PRIVATE → owner; SHARED → owner + share users; ORG → everyone once PUBLISHED/APPROVED (or
 * previously approved and awaiting re-approval); PENDING_APPROVAL → owner + approvers.
 * Admins may open everything (see loadElement) but listings only add others' private items with `adminAll`.
 */
export function visibleWhere(ctx: Ctx, opts: { adminAll?: boolean; includeDeprecated?: boolean } = {}): Prisma.LibraryElementWhereInput {
  const ws: Prisma.LibraryElementWhereInput = { library: { workspaceId: ctx.workspace.id } };
  if (opts.adminAll && isAdmin(ctx)) return ws;
  const orgStatuses: LibStatus[] = opts.includeDeprecated ? [...ORG_LIVE, "DEPRECATED"] : ORG_LIVE;
  const or: Prisma.LibraryElementWhereInput[] = [
    { ownerId: ctx.user.id },
    { visibility: "SHARED", shares: { some: { userId: ctx.user.id } } },
    { visibility: "ORG", status: { in: orgStatuses } },
    { visibility: "ORG", approvedAt: { not: null }, status: { in: ["DRAFT", "PENDING_APPROVAL"] } },
  ];
  if (isApprover(ctx)) or.push({ status: "PENDING_APPROVAL" });
  return { AND: [ws, { OR: or }] };
}

export type ElementWithRels = LibraryElement & { library: Library; shares: { userId: string; canEdit: boolean }[] };

export type Access = {
  el: ElementWithRels;
  isOwner: boolean;
  canView: boolean;
  /** full view: latest revision, drafts, history */
  full: boolean;
  canEdit: boolean;
  canManage: boolean; // share, visibility, delete
  canApprove: boolean;
  canDeprecate: boolean;
  /** revision a plain org viewer gets (the last approved one while a new one awaits approval) */
  viewerRevision: number;
};

export function accessFor(ctx: Ctx, el: ElementWithRels): Access {
  const isOwner = el.ownerId === ctx.user.id;
  const share = el.shares.find((s) => s.userId === ctx.user.id);
  const admin = isAdmin(ctx);
  const approver = isApprover(ctx);
  const inWs = el.library.workspaceId === ctx.workspace.id;
  const meta = J.parse<Record<string, unknown>>(el.meta, {});
  const approvedRev = Number(meta[APPROVED_REV_KEY]) || null;
  const orgLive = el.visibility === "ORG" && (ORG_LIVE.includes(el.status as LibStatus) || el.status === "DEPRECATED");
  const orgPrevApproved = el.visibility === "ORG" && !!el.approvedAt && !!approvedRev;
  const sharedWithMe = el.visibility === "SHARED" && !!share;
  const full = inWs && (isOwner || admin || (approver && el.status === "PENDING_APPROVAL") || sharedWithMe || (approver && el.visibility === "ORG"));
  const canView = inWs && (full || orgLive || orgPrevApproved);
  const canEdit = inWs && !isGuestCtx(ctx) && (isOwner || admin || (sharedWithMe && !!share?.canEdit));
  let viewerRevision = el.revision;
  if (!full && !orgLive && orgPrevApproved && approvedRev) viewerRevision = approvedRev;
  return {
    el,
    isOwner,
    canView,
    full,
    canEdit,
    canManage: inWs && (isOwner || admin),
    canApprove: inWs && approver,
    canDeprecate: inWs && (admin || approver),
    viewerRevision,
  };
}

export async function loadElement(ctx: Ctx, id: string): Promise<Access> {
  const el = await db.libraryElement.findUnique({ where: { id }, include: { library: true, shares: { select: { userId: true, canEdit: true } } } });
  if (!el) throw new HttpError(404, "Library element not found");
  const a = accessFor(ctx, el);
  if (!a.canView) throw new HttpError(404, "Library element not found");
  return a;
}

/** The user's personal library in the current workspace (created on demand). */
export async function personalLibrary(ctx: Ctx): Promise<Library> {
  const found = await db.library.findFirst({ where: { workspaceId: ctx.workspace.id, scope: "PERSONAL", ownerId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  if (found) return found;
  return db.library.create({ data: { workspaceId: ctx.workspace.id, scope: "PERSONAL", ownerId: ctx.user.id, name: `${ctx.user.name} — personal`, description: "Personal components" } });
}

/** Library the user may add elements to. */
export async function writableLibrary(ctx: Ctx, libraryId?: string | null): Promise<Library> {
  if (!libraryId) return personalLibrary(ctx);
  const lib = await db.library.findUnique({ where: { id: libraryId } });
  if (!lib || lib.workspaceId !== ctx.workspace.id) throw new HttpError(404, "Library not found");
  if (!canWriteLibrary(ctx, lib)) throw new HttpError(403, "You cannot add elements to this library");
  return lib;
}

export function canWriteLibrary(ctx: Ctx, lib: Library): boolean {
  if (isGuestCtx(ctx)) return false;
  if (isAdmin(ctx) || lib.ownerId === ctx.user.id) return true;
  return lib.scope === "ORG" && canPublish(ctx);
}

export function canManageLibrary(ctx: Ctx, lib: Library): boolean {
  return !isGuestCtx(ctx) && (isAdmin(ctx) || lib.ownerId === ctx.user.id);
}

/** Libraries shown in the selector: ORG/SHARED ones + my own personal ones (+ all for admins). */
export function librariesWhere(ctx: Ctx): Prisma.LibraryWhereInput {
  if (isAdmin(ctx)) return { workspaceId: ctx.workspace.id };
  return { workspaceId: ctx.workspace.id, OR: [{ scope: { in: ["ORG", "SHARED"] } }, { ownerId: ctx.user.id }] };
}

/** Public metadata: strips hidden keys. */
export function publicMeta(meta: string): Record<string, string> {
  const m = J.parse<Record<string, unknown>>(meta, {});
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith("__") && v !== undefined && v !== null) out[k] = String(v);
  return out;
}

export type LibItemOut = {
  id: string;
  kind: "ELEMENT" | "BLOCK";
  name: string;
  category: string;
  prefix: string;
  tags: string[];
  visibility: Visibility;
  status: string;
  revision: number;
  ownerName?: string;
  ownerId: string;
  libraryName?: string;
  libraryId: string;
  updatedAt?: string;
  description?: string;
  canEdit: boolean;
  shared?: boolean;
  rejectReason?: string;
};

export function toLibItem(ctx: Ctx, el: ElementWithRels, ownerName?: string): LibItemOut {
  const a = accessFor(ctx, el);
  const meta = J.parse<Record<string, unknown>>(el.meta, {});
  const pinned = a.viewerRevision !== el.revision;
  return {
    id: el.id,
    kind: el.kind === "BLOCK" ? "BLOCK" : "ELEMENT",
    name: el.name,
    category: el.category,
    prefix: el.prefix,
    tags: J.parse<string[]>(el.tags, []),
    visibility: el.visibility as Visibility,
    status: pinned ? "APPROVED" : el.status,
    revision: a.viewerRevision,
    ownerName,
    ownerId: el.ownerId,
    libraryName: el.library.name,
    libraryId: el.libraryId,
    updatedAt: el.updatedAt.toISOString(),
    description: el.description,
    canEdit: a.canEdit,
    shared: el.visibility === "SHARED" && el.shares.some((s) => s.userId === ctx.user.id),
    rejectReason: a.full && typeof meta[REJECT_KEY] === "string" ? (meta[REJECT_KEY] as string) : undefined,
  };
}

/** User ids holding library.approve in the workspace (direct membership roles). */
export async function approverIds(workspaceId: string): Promise<string[]> {
  const mems = await db.membership.findMany({ where: { workspaceId }, include: { user: { select: { disabled: true } } } });
  return mems.filter((m) => !m.user.disabled && rolesAllow(parseRoles(m.roles), "library.approve")).map((m) => m.userId);
}

/**
 * Publish-to-organization transition. Returns the new status.
 * requireApprovalForOrg && !approver → PENDING_APPROVAL (+ notify approvers); approver → APPROVED; otherwise PUBLISHED.
 */
export async function publishToOrg(ctx: Ctx, el: LibraryElement): Promise<LibStatus> {
  if (!canPublish(ctx)) throw new HttpError(403, "Your role cannot publish components to the organization");
  const meta = J.parse<Record<string, unknown>>(el.meta, {});
  delete meta[REJECT_KEY];
  const needs = ctx.settings.library.requireApprovalForOrg && !isApprover(ctx);
  let status: LibStatus;
  if (needs) {
    status = "PENDING_APPROVAL";
    await db.libraryElement.update({ where: { id: el.id }, data: { visibility: "ORG", status, meta: JSON.stringify(meta) } });
    const ids = (await approverIds(ctx.workspace.id)).filter((u) => u !== ctx.user.id);
    await notify(ids, {
      type: "library.approval",
      title: `Approval requested: ${el.name}`,
      body: `${ctx.user.name} submitted “${el.name}” (rev ${el.revision}) for use across the organization.`,
      link: `/library/${el.id}`,
      workspaceId: ctx.workspace.id,
    });
  } else if (isApprover(ctx)) {
    status = "APPROVED";
    meta[APPROVED_REV_KEY] = el.revision;
    await db.libraryElement.update({ where: { id: el.id }, data: { visibility: "ORG", status, approvedById: ctx.user.id, approvedAt: new Date(), meta: JSON.stringify(meta) } });
  } else {
    status = "PUBLISHED";
    await db.libraryElement.update({ where: { id: el.id }, data: { visibility: "ORG", status, meta: JSON.stringify(meta) } });
  }
  return status;
}

export function tagsIn(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((t) => String(t).trim()).filter(Boolean))].slice(0, 40);
}
