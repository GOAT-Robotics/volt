"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PenLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Checkbox, Spinner } from "@/components/ui/misc";
import { PromptDialog } from "@/components/volt/common";
import { api } from "@/lib/fetcher";

export function SignForm({ signatureId, fullName, projectId }: { signatureId: string; fullName: string; projectId: string }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [accept, setAccept] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [decline, setDecline] = React.useState(false);
  const matches = name.trim().replace(/\s+/g, " ").toLowerCase() === fullName.trim().replace(/\s+/g, " ").toLowerCase();
  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matches || !accept) return;
    setBusy(true);
    try {
      const j = await api<{ versionStatus: string }>(`/api/signatures/${signatureId}/sign`, { method: "POST", json: { fullName: name, accept: true } });
      toast.success(j.versionStatus === "SIGNED" ? "Signed — all signatures are complete" : "Signed — the next signatory has been notified");
      router.push(`/projects/${projectId}?tab=signatures`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
      router.refresh();
    }
  };
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <form onSubmit={sign} className="space-y-3">
        <h2 className="text-xs font-semibold">Sign</h2>
        <Field label={<>Type your full name: <span className="font-semibold text-fg">{fullName}</span></>}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-invalid={!!name && !matches} aria-describedby="name-hint" autoFocus />
        </Field>
        <p id="name-hint" className="text-2xs text-muted" aria-live="polite">
          {name && !matches ? "The name must match your account name exactly." : " "}
        </p>
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <Checkbox className="mt-0.5" checked={accept} onCheckedChange={(c) => setAccept(!!c)} />
          <span>I agree to the signature statement and confirm the hashes shown refer to the drawing I reviewed.</span>
        </label>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button type="button" variant="danger-ghost" onClick={() => setDecline(true)}>
            <X /> Decline
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={busy || !matches || !accept}>
            {busy ? <Spinner /> : <PenLine />} Sign version
          </Button>
        </div>
      </form>
      <PromptDialog
        open={decline}
        onOpenChange={setDecline}
        danger
        title="Decline to sign?"
        description="The requester is notified and the remaining requests in this round are cancelled. They can request signatures again after resolving your concern."
        confirmLabel="Decline"
        reason
        onConfirm={async (reason) => {
          try {
            await api(`/api/signatures/${signatureId}/decline`, { method: "POST", json: { reason } });
            toast.success("Declined");
            setDecline(false);
            router.push(`/projects/${projectId}?tab=signatures`);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </section>
  );
}
