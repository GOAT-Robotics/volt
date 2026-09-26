"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, BadgeCheck, Building2, ChevronRight, Copy, Download, Link2, MoreHorizontal, Send, Share2, ThumbsDown, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status";
import { Badge, Tip } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/fetcher";
import { relTime } from "@/lib/utils";
import type { ElementDetail, LibUser } from "../types";
import { ShareDialog } from "./ShareDialog";
import { ConfirmDialog, PromptDialog } from "./common";

export function WorkflowBar({ d, user, reload, extra, dirty }: { d: ElementDetail; user: LibUser; reload: () => void; extra?: React.ReactNode; dirty?: boolean }) {
  const router = useRouter();
  const [share, setShare] = useState(false);
  const [reject, setReject] = useState(false);
  const [deprecate, setDeprecate] = useState(false);
  const [del, setDel] = useState(false);
  const [usage, setUsage] = useState<{ count: number; usages: { projectName: string; label: string }[] } | null>(null);
  const a = d.access;
  const needsApproval = user.requireApproval && !user.isApprover;
  const live = d.visibility === "ORG" && (d.status === "APPROVED" || d.status === "PUBLISHED");

  const act = async (action: string, reason?: string) => {
    try {
      const j = await api<{ status: string }>(`/api/library/elements/${d.id}/workflow`, { method: "POST", json: { action, reason } });
      const msg: Record<string, string> = {
        publish: j.status === "PENDING_APPROVAL" ? "Submitted for approval — approvers have been notified" : j.status === "APPROVED" ? "Published and approved for the organization" : "Published to the organization",
        approve: "Approved — now available to everyone",
        reject: "Sent back to the author",
        withdraw: "Approval request withdrawn",
        deprecate: "Marked as deprecated",
        undeprecate: "Deprecation removed",
      };
      toast.success(msg[action] ?? "Done");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const duplicate = async () => {
    if (dirty && !confirm("You have unsaved changes. Duplicate the last saved revision anyway?")) return;
    try {
      const j = await api<{ id: string }>(`/api/library/elements/${d.id}/duplicate`, { method: "POST", json: {} });
      toast.success("Copy created in your personal library");
      router.push(`/library/${j.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openDelete = async () => {
    setDel(true);
    setUsage(null);
    try {
      setUsage(await api(`/api/library/elements/${d.id}/usage`));
    } catch {}
  };

  return (
    <div className="border-b border-border bg-panel px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <nav className="flex items-center gap-1 text-2xs text-subtle" aria-label="Breadcrumb">
            <Link href="/library" className="hover:text-fg hover:underline">
              Library
            </Link>
            {d.category.split("/").filter(Boolean).map((c, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="size-3" />
                <Link href={`/library?category=${encodeURIComponent(arr.slice(0, i + 1).join("/"))}`} className="hover:text-fg hover:underline">
                  {c}
                </Link>
              </span>
            ))}
          </nav>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{d.name}</h1>
            {d.prefix && <Badge>{d.prefix}</Badge>}
            <StatusBadge status={d.status} />
            <StatusBadge status={d.visibility} />
            <span className="text-2xs text-subtle">
              rev {d.revision}
              {d.approvedRevision && d.approvedRevision !== d.revision && d.visibility === "ORG" ? ` · approved rev ${d.approvedRevision} in use` : ""} · {d.library.name} · {d.ownerName ?? "—"} · updated {relTime(d.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.canManage && (
            <Button size="sm" onClick={() => setShare(true)}>
              <Share2 /> Share
            </Button>
          )}
          {a.canManage && !live && d.status !== "PENDING_APPROVAL" && d.status !== "DEPRECATED" && user.canPublish && (
            <Tip content={needsApproval ? "An approver must accept it before everyone can use it" : "Make it available to everyone in the workspace"}>
              <Button size="sm" onClick={() => (dirty ? toast.warning("Save your changes first") : act("publish"))}>
                {needsApproval ? <Send /> : <Building2 />} {needsApproval ? "Submit for approval" : "Publish to organization"}
              </Button>
            </Tip>
          )}
          {a.canManage && d.status === "PENDING_APPROVAL" && !a.canApprove && (
            <Button size="sm" variant="ghost" onClick={() => act("withdraw")}>
              <Undo2 /> Withdraw request
            </Button>
          )}
          {a.canApprove && d.status === "PENDING_APPROVAL" && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setReject(true)}>
                <ThumbsDown /> Reject
              </Button>
              <Button size="sm" variant="primary" onClick={() => act("approve")}>
                <BadgeCheck /> Approve
              </Button>
            </>
          )}
          {extra}
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={duplicate}>
                <Copy /> Duplicate to my library
              </MenuItem>
              <MenuItem onSelect={() => (location.href = `/api/library/elements/${d.id}/export?rev=${d.revision}`)}>
                <Download /> {d.kind === "BLOCK" ? "Export block (.json)" : "Export .elmt (QElectroTech)"}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  navigator.clipboard?.writeText(`${location.origin}/library/${d.id}`);
                  toast.success("Link copied");
                }}
              >
                <Link2 /> Copy link
              </MenuItem>
              {a.canDeprecate && (
                <>
                  <MenuSeparator />
                  {d.status === "DEPRECATED" ? (
                    <MenuItem onSelect={() => act("undeprecate")}>
                      <ArchiveRestore /> Remove deprecation
                    </MenuItem>
                  ) : (
                    <MenuItem onSelect={() => setDeprecate(true)}>
                      <Archive /> Deprecate…
                    </MenuItem>
                  )}
                </>
              )}
              {a.canManage && (
                <>
                  <MenuSeparator />
                  <MenuItem danger onSelect={openDelete}>
                    <Trash2 /> Delete…
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {d.rejectReason && d.status === "DRAFT" && (
        <p className="mt-2 rounded-md border border-danger/20 bg-danger-soft px-3 py-1.5 text-2xs text-danger">
          <strong>Not approved:</strong> {d.rejectReason} — fix it, save a new revision and submit again.
        </p>
      )}
      {d.status === "DEPRECATED" && (
        <p className="mt-2 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-2xs text-muted">
          <strong>Deprecated.</strong> {d.meta.deprecationNote ?? "Existing diagrams keep working, but new designs should use a replacement."}
        </p>
      )}
      {share && <ShareDialog id={d.id} name={d.name} status={d.status} user={user} open onClose={() => setShare(false)} onSaved={reload} />}
      <PromptDialog open={reject} title="Reject element" description="The author gets your reason and the element returns to draft." label="What needs to change?" required confirm="Reject" danger onClose={() => setReject(false)} onSubmit={async (v) => (await act("reject", v), setReject(false))} />
      <PromptDialog open={deprecate} title="Deprecate element" description="Deprecated elements are hidden from search but keep working in existing diagrams." label="Note (e.g. the replacement to use)" confirm="Deprecate" onClose={() => setDeprecate(false)} onSubmit={async (v) => (await act("deprecate", v), setDeprecate(false))} />
      <ConfirmDialog
        open={del}
        danger
        title={`Delete “${d.name}”?`}
        description="The element and all its revisions are removed from the library. This cannot be undone."
        confirm="Delete permanently"
        onClose={() => setDel(false)}
        onConfirm={async () => {
          try {
            await api(`/api/library/elements/${d.id}`, { method: "DELETE" });
            toast.success("Deleted");
            router.push("/library");
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      >
        {usage === null ? (
          <p className="text-2xs text-subtle">Checking where it is used…</p>
        ) : usage.count ? (
          <div className="rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-2xs text-warning">
            <p className="font-medium">Used in {usage.count} drawing version(s):</p>
            <ul className="mt-1 list-disc pl-4">
              {usage.usages.slice(0, 6).map((u, i) => (
                <li key={i}>
                  {u.projectName} — v{u.label}
                </li>
              ))}
            </ul>
            <p className="mt-1">Those drawings keep their embedded copy, but can no longer check for updates. Consider deprecating instead.</p>
          </div>
        ) : (
          <p className="text-2xs text-muted">Not used in any drawing.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
