"use client";
import { useEffect, useRef, useState } from "react";
import { Building2, Loader2, Lock, Users, X, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, Switch, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import type { LibUser, Visibility } from "../types";

type Share = { userId?: string; email?: string; name: string; canEdit: boolean };
type U = { id: string; name: string; email: string };

/** Searches workspace users: /api/users (workspace directory) with a library-local fallback. */
export async function searchUsers(q: string): Promise<U[]> {
  for (const url of [`/api/users?q=${encodeURIComponent(q)}`, `/api/library/users?q=${encodeURIComponent(q)}`]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = (await r.json()) as { users?: U[] };
      if (Array.isArray(j.users)) return j.users;
    } catch {}
  }
  return [];
}

export function ShareDialog({ id, name, status, user, open, onClose, onSaved }: { id: string; name: string; status: string; user: LibUser; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(true);
  const [vis, setVis] = useState<Visibility>("PRIVATE");
  const [origVis, setOrigVis] = useState<Visibility>("PRIVATE");
  const [shares, setShares] = useState<Share[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<U[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<{ visibility: Visibility; shares: { userId: string; name: string; email: string; canEdit: boolean }[] }>(`/api/library/elements/${id}/share`)
      .then((j) => {
        setVis(j.visibility);
        setOrigVis(j.visibility);
        setShares(j.shares.map((s) => ({ userId: s.userId, name: s.name, email: s.email, canEdit: s.canEdit })));
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [id, open]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 1) return setResults([]);
    const my = ++seq.current;
    setSearching(true);
    const h = setTimeout(async () => {
      const users = await searchUsers(t);
      if (my === seq.current) {
        setResults(users.filter((u) => u.id !== user.id && !shares.some((s) => s.userId === u.id)).slice(0, 8));
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(h);
  }, [q, shares, user.id]);

  const add = (s: Share) => {
    setShares((x) => [...x, s]);
    setQ("");
    setResults([]);
    if (vis === "PRIVATE") setVis("SHARED");
  };
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim());

  const save = async () => {
    setBusy(true);
    try {
      const j = await api<{ errors: string[]; status: string }>(`/api/library/elements/${id}/share`, {
        method: "PUT",
        json: { visibility: vis, shares: shares.map((s) => (s.userId ? { userId: s.userId, canEdit: s.canEdit } : { email: s.email, canEdit: s.canEdit })) },
      });
      j.errors.forEach((e) => toast.warning(e));
      if (vis === "ORG" && origVis !== "ORG") toast.success(j.status === "PENDING_APPROVAL" ? "Submitted for approval — approvers have been notified" : "Published to the organization");
      else toast.success("Sharing updated");
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsApproval = user.requireApproval && !user.isApprover;
  const opts = [
    { id: "PRIVATE" as const, icon: <Lock />, label: "Only me", desc: "Personal draft, invisible to others." },
    { id: "SHARED" as const, icon: <Users />, label: "Specific people", desc: "Only the people listed below." },
    {
      id: "ORG" as const,
      icon: <Building2 />,
      label: "Organization",
      desc: !user.canPublish ? "Your role cannot publish to the organization." : needsApproval ? "Everyone, after an approver accepts it." : "Everyone in the workspace can reuse it.",
      disabled: !user.canPublish,
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Share “${name}”`} description="Decide who can find and reuse this component." wide>
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Visibility">
              {opts.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={vis === o.id}
                  disabled={"disabled" in o && o.disabled}
                  onClick={() => setVis(o.id)}
                  className={cn("rounded-lg border p-2.5 text-left disabled:opacity-40 [&_svg]:size-3.5", vis === o.id ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")}
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    {o.icon}
                    {o.label}
                  </p>
                  <p className="mt-0.5 text-2xs text-muted">{o.desc}</p>
                </button>
              ))}
            </div>
            {vis === "ORG" && origVis !== "ORG" && (
              <p className="rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-2xs text-warning">
                {needsApproval ? "Saving submits this element for approval. Approvers are notified; it becomes visible to everyone once approved." : "Saving publishes this element to everyone in the workspace."}
              </p>
            )}
            {origVis === "ORG" && vis !== "ORG" && (
              <p className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-2xs text-danger">
                The element will be removed from the organization library{status === "APPROVED" ? " and lose its approval" : ""}. Existing diagrams keep their copy.
              </p>
            )}
            <div>
              <p className="mb-1.5 text-2xs font-medium text-muted">People with access {vis === "ORG" && <span className="font-normal text-subtle">(editors can change it; everyone can view)</span>}</p>
              <div className="relative">
                <UserPlus className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Add people by name or email…"
                  className="pl-7"
                  aria-label="Search people"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && emailLike && !results.length) add({ email: q.trim().toLowerCase(), name: q.trim(), canEdit: false });
                  }}
                />
                {searching && <Spinner className="absolute right-2 top-2 size-3" />}
                {(results.length > 0 || (emailLike && !searching)) && q && (
                  <div className="absolute inset-x-0 top-8 z-10 rounded-lg border border-border bg-panel p-1 shadow-pop">
                    {results.map((u) => (
                      <button key={u.id} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover" onClick={() => add({ userId: u.id, name: u.name, email: u.email, canEdit: false })}>
                        <Avatar name={u.name} size={20} />
                        <span className="min-w-0 flex-1 truncate">{u.name}</span>
                        <span className="truncate text-2xs text-subtle">{u.email}</span>
                      </button>
                    ))}
                    {!results.length && emailLike && (
                      <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover" onClick={() => add({ email: q.trim().toLowerCase(), name: q.trim(), canEdit: false })}>
                        <UserPlus className="size-3.5" /> Add {q.trim()}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                <li className="flex items-center gap-2 px-3 py-2 text-xs">
                  <Avatar name={user.name} size={20} />
                  <span className="flex-1">{user.name} (you)</span>
                  <span className="text-2xs text-subtle">Owner</span>
                </li>
                {shares.map((s, i) => (
                  <li key={s.userId ?? s.email} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <Avatar name={s.name} size={20} />
                    <span className="min-w-0 flex-1 truncate">
                      {s.name} {s.email && s.email !== s.name && <span className="text-2xs text-subtle">{s.email}</span>}
                    </span>
                    <label className="flex items-center gap-1.5 text-2xs text-muted">
                      <Switch checked={s.canEdit} onCheckedChange={(v) => setShares((x) => x.map((y, k) => (k === i ? { ...y, canEdit: v } : y)))} aria-label={`${s.name} can edit`} />
                      Can edit
                    </label>
                    <button className="rounded p-1 text-subtle hover:bg-hover hover:text-danger" aria-label={`Remove ${s.name}`} onClick={() => setShares((x) => x.filter((_, k) => k !== i))}>
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
                {!shares.length && <li className="px-3 py-2 text-2xs text-subtle">Not shared with anyone else.</li>}
              </ul>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || loading || (vis === "SHARED" && !shares.length)}>
            {busy && <Loader2 className="animate-spin" />}
            {vis === "ORG" && origVis !== "ORG" ? (needsApproval ? "Submit for approval" : "Publish") : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
