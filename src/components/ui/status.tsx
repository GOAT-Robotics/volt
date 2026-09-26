import { Badge, type Tone } from "./misc";

const MAP: Record<string, [string, Tone]> = {
  DRAFT: ["Draft", "neutral"],
  IN_REVIEW: ["In review", "accent"],
  CHANGES_REQUESTED: ["Changes requested", "warning"],
  APPROVED: ["Approved", "success"],
  REJECTED: ["Rejected", "danger"],
  SIGNED: ["Signed", "purple"],
  RELEASED: ["Released", "success"],
  SUPERSEDED: ["Superseded", "neutral"],
  WITHDRAWN: ["Withdrawn", "danger"],
  OPEN: ["Open", "accent"],
  RESOLVED: ["Resolved", "success"],
  REOPENED: ["Reopened", "warning"],
  PENDING: ["Pending", "neutral"],
  REQUESTED: ["Requested", "accent"],
  DECLINED: ["Declined", "danger"],
  EXPIRED: ["Expired", "neutral"],
  INVALIDATED: ["Invalidated", "danger"],
  CANCELLED: ["Cancelled", "neutral"],
  PUBLISHED: ["Published", "accent"],
  PENDING_APPROVAL: ["Pending approval", "warning"],
  DEPRECATED: ["Deprecated", "neutral"],
  PRIVATE: ["Private", "neutral"],
  SHARED: ["Shared", "accent"],
  ORG: ["Organization", "success"],
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const [label, tone] = MAP[status] ?? [status, "neutral" as Tone];
  return (
    <Badge tone={tone} dot className={className}>
      {label}
    </Badge>
  );
}
