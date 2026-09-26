"use client";
import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  wide,
  ...p
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; wide?: boolean | "xl" }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px] data-[state=open]:animate-[vin_120ms]" />
      <D.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-panel shadow-pop outline-none animate-in",
          wide === "xl" ? "max-w-5xl" : wide ? "max-w-2xl" : "max-w-md",
          className,
        )}
        {...p}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <D.Title className="text-sm font-semibold">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-xs text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
          </div>
          <D.Close className="rounded p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="size-3.5" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("-mx-4 -mb-3 mt-4 flex items-center justify-end gap-2 border-t border-border bg-panel-2 px-4 py-2.5 rounded-b-xl", className)} {...p} />;
}
