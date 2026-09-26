"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Symbol preview image, lazy loaded, readable in dark mode. */
export function PreviewImg({ id, rev, className, label, pins, alt = "" }: { id: string; rev?: number; className?: string; label?: string; pins?: boolean; alt?: string }) {
  const q = new URLSearchParams();
  if (rev) q.set("rev", String(rev));
  if (label) q.set("label", label);
  if (pins) q.set("pins", "1");
  const [err, setErr] = useState(false);
  return err ? (
    <span className={cn("text-2xs text-subtle", className)}>No preview</span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/library/elements/${id}/preview.svg?${q}`} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setErr(true)} className={cn("select-none object-contain dark:invert dark:hue-rotate-180", className)} />
  );
}

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  confirm,
  danger,
  required,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  confirm: string;
  danger?: boolean;
  required?: boolean;
  onClose: () => void;
  onSubmit: (v: string) => Promise<void> | void;
}) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description}>
        <Field label={label}>
          <Textarea autoFocus rows={3} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={busy || (required && !v.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(v.trim());
                setV("");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({ open, title, description, confirm, danger, onClose, onConfirm, children }: { open: boolean; title: string; description?: React.ReactNode; confirm: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> | void; children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description}>
        {children}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function categoryTrail(c: string) {
  return c ? c.split("/").join(" › ") : "Uncategorized";
}
