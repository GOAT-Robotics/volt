"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Avatar, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

/** Run an async mutation with toasts + router refresh. Returns [run, busy]. */
export function useMutation() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const run = React.useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string | void), opts: { refresh?: boolean } = {}): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        const msg = typeof ok === "function" ? ok(r) : ok;
        if (msg) toast.success(msg);
        if (opts.refresh !== false) router.refresh();
        return r;
      } catch (e) {
        toast.error((e as Error).message || "Something went wrong");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );
  return [run, busy] as const;
}

/** Confirm / reason prompt dialog. */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  danger,
  reason,
  reasonLabel = "Reason",
  reasonRequired = true,
  typeToConfirm,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  reason?: boolean;
  reasonLabel?: string;
  reasonRequired?: boolean;
  typeToConfirm?: string;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  children?: React.ReactNode;
}) {
  const [text, setText] = React.useState("");
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setText("");
      setTyped("");
    }
  }, [open]);
  const disabled = busy || (reason && reasonRequired && !text.trim()) || (typeToConfirm !== undefined && typed.trim() !== typeToConfirm);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setBusy(true);
    try {
      await onConfirm(text.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <form onSubmit={submit} className="space-y-3">
          {children}
          {reason && (
            <Field label={`${reasonLabel}${reasonRequired ? "" : " (optional)"}`}>
              <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} required={reasonRequired} />
            </Field>
          )}
          {typeToConfirm !== undefined && (
            <Field label={<>Type <span className="font-semibold text-fg">{typeToConfirm}</span> to confirm</>}>
              <Input autoFocus={!reason} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation" />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={danger ? "danger" : "primary"} disabled={!!disabled}>
              {busy && <Spinner />} {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type PickedUser = { id: string; name: string; email: string };

/** Searchable user picker (workspace members). */
export function UserSearch({ onPick, role, projectId, exclude = [], placeholder = "Search people by name or email…", autoFocus }: { onPick: (u: PickedUser) => void; role?: "review" | "approve" | "sign"; projectId?: string; exclude?: string[]; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<PickedUser[]>([]);
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const id = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const sp = new URLSearchParams({ q, limit: "12" });
        if (role) sp.set("role", role);
        if (projectId) sp.set("projectId", projectId);
        const j = await api<{ users: PickedUser[] }>(`/api/users?${sp}`);
        setItems(j.users.filter((u) => !exclude.includes(u.id)));
        setHi(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, role, projectId, exclude.join(",")]);
  const pick = (u: PickedUser) => {
    onPick(u);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
      <Input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, items.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
          else if (e.key === "Enter" && items[hi]) (e.preventDefault(), pick(items[hi]));
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        className="pl-7"
        role="combobox"
        aria-expanded={open}
        aria-controls={id}
        aria-autocomplete="list"
      />
      {open && (
        <ul id={id} role="listbox" className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-panel p-1 shadow-pop">
          {loading && !items.length ? (
            <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted">
              <Spinner /> Searching…
            </li>
          ) : !items.length ? (
            <li className="px-2 py-1.5 text-xs text-muted">No matching people{role ? " with the required role" : ""}</li>
          ) : (
            items.map((u, i) => (
              <li
                key={u.id}
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => (e.preventDefault(), pick(u))}
                onMouseEnter={() => setHi(i)}
                className={cn("flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-xs", i === hi && "bg-hover")}
              >
                <Avatar name={u.name} size={20} />
                <span className="font-medium">{u.name}</span>
                <span className="truncate text-muted">{u.email}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Comma/enter separated tag editor. */
export function TagInput({ value, onChange, placeholder = "Add tag…", id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string }) {
  const [t, setT] = React.useState("");
  const add = () => {
    const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])].slice(0, 20));
    setT("");
  };
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1 rounded-md border border-border bg-panel px-1.5 py-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
      {value.map((v) => (
        <span key={v} className="inline-flex h-5 items-center gap-1 rounded bg-hover px-1.5 text-2xs">
          {v}
          <button type="button" aria-label={`Remove tag ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="text-muted hover:text-fg">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !t && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? "" : placeholder}
        className="h-5 min-w-20 flex-1 bg-transparent text-xs outline-none placeholder:text-subtle"
      />
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-panel", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold">{title}</h2>
          {description && <p className="text-2xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("break-all rounded bg-panel-2 px-1 py-0.5 font-mono text-[10.5px] text-muted", className)}>{children}</code>;
}

export function Forbidden({ title = "You don’t have access", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-3xl font-semibold text-subtle">403</p>
      <h1 className="text-sm font-semibold">{title}</h1>
      <p className="max-w-sm text-xs text-muted">{children ?? "This area is restricted. Ask a workspace administrator if you need access."}</p>
    </div>
  );
}
