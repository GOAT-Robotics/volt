import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { APPROVED_REV_KEY, REJECT_KEY, assertMember, loadElement, publishToOrg } from "@/lib/library/access";

export const runtime = "nodejs";

const Body = z.object({
  action: z.enum(["publish", "approve", "reject", "deprecate", "undeprecate", "withdraw"]),
  reason: z.string().max(2000).optional(),
});

/**
 * Library workflow:
 *  publish     → ORG + (PENDING_APPROVAL | APPROVED | PUBLISHED) depending on policy and role
 *  approve     → APPROVED (approvers)            reject → DRAFT with reason (approvers)
 *  deprecate   → DEPRECATED (admins/approvers)   undeprecate → APPROVED/PUBLISHED
 *  withdraw    → owner cancels a pending approval request (back to DRAFT)
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const el = a.el;
  const b = await body(req, Body);
  const meta = J.parse<Record<string, unknown>>(el.meta, {});
  let status = el.status;

  switch (b.action) {
    case "publish": {
      if (!a.canManage) throw new HttpError(403, "Only the owner can publish this element");
      if (el.status === "PENDING_APPROVAL") throw new HttpError(409, "Already awaiting approval");
      if (el.visibility === "ORG" && (el.status === "APPROVED" || el.status === "PUBLISHED")) throw new HttpError(409, "Already published to the organization");
      status = await publishToOrg(ctx, el);
      await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: status === "PENDING_APPROVAL" ? "library.submit" : "library.publish", data: { id, name: el.name, revision: el.revision, status } });
      break;
    }
    case "approve": {
      if (!a.canApprove) throw new HttpError(403, "You are not a library approver");
      if (el.status !== "PENDING_APPROVAL") throw new HttpError(409, "This element is not awaiting approval");
      status = "APPROVED";
      meta[APPROVED_REV_KEY] = el.revision;
      delete meta[REJECT_KEY];
      await db.libraryElement.update({ where: { id }, data: { status, visibility: "ORG", approvedById: ctx.user.id, approvedAt: new Date(), meta: JSON.stringify(meta) } });
      await notify([el.ownerId].filter((u) => u !== ctx.user.id), {
        type: "library.approval",
        title: `Approved: ${el.name}`,
        body: `${ctx.user.name} approved “${el.name}” (rev ${el.revision}). It is now available to the whole organization.${b.reason ? `\n\n${b.reason}` : ""}`,
        link: `/library/${id}`,
        workspaceId: ctx.workspace.id,
      });
      await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.approve", data: { id, name: el.name, revision: el.revision, comment: b.reason ?? null } });
      break;
    }
    case "reject": {
      if (!a.canApprove) throw new HttpError(403, "You are not a library approver");
      if (el.status !== "PENDING_APPROVAL") throw new HttpError(409, "This element is not awaiting approval");
      if (!b.reason?.trim()) throw new HttpError(400, "Please give a reason so the author can fix it");
      status = "DRAFT";
      meta[REJECT_KEY] = b.reason.trim();
      await db.libraryElement.update({ where: { id }, data: { status, meta: JSON.stringify(meta) } });
      await notify([el.ownerId].filter((u) => u !== ctx.user.id), {
        type: "library.approval",
        title: `Changes needed: ${el.name}`,
        body: `${ctx.user.name} did not approve “${el.name}” (rev ${el.revision}): ${b.reason.trim()}`,
        link: `/library/${id}`,
        workspaceId: ctx.workspace.id,
      });
      await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.reject", data: { id, name: el.name, revision: el.revision, reason: b.reason.trim() } });
      break;
    }
    case "withdraw": {
      if (!a.canManage) throw new HttpError(403, "Only the owner can withdraw the request");
      if (el.status !== "PENDING_APPROVAL") throw new HttpError(409, "Nothing to withdraw");
      status = "DRAFT";
      await db.libraryElement.update({ where: { id }, data: { status } });
      await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.withdraw", data: { id, name: el.name, revision: el.revision } });
      break;
    }
    case "deprecate":
    case "undeprecate": {
      if (!a.canDeprecate) throw new HttpError(403, "Only administrators and library approvers can deprecate elements");
      if (b.action === "deprecate") {
        if (el.status === "DEPRECATED") throw new HttpError(409, "Already deprecated");
        status = "DEPRECATED";
        meta.__deprecatedFrom = el.status;
        if (b.reason) meta.deprecationNote = b.reason;
      } else {
        if (el.status !== "DEPRECATED") throw new HttpError(409, "Not deprecated");
        const from = String(meta.__deprecatedFrom ?? "");
        status = from === "APPROVED" || from === "PUBLISHED" || from === "DRAFT" ? from : el.approvedAt ? "APPROVED" : "PUBLISHED";
        delete meta.__deprecatedFrom;
        delete meta.deprecationNote;
      }
      await db.libraryElement.update({ where: { id }, data: { status, meta: JSON.stringify(meta) } });
      await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: `library.${b.action}`, data: { id, name: el.name, reason: b.reason ?? null } });
      break;
    }
  }
  return { id, status };
});
