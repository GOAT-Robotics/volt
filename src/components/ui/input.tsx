import * as React from "react";
import { cn } from "@/lib/utils";

export const inputCls =
  "h-7 w-full rounded-md border border-border bg-panel px-2 text-xs text-fg placeholder:text-subtle outline-none transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(inputCls, className)} {...p} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(inputCls, "h-auto min-h-16 py-1.5 leading-snug", className)} {...p} />
));
Textarea.displayName = "Textarea";

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-2xs font-medium text-muted", className)} {...p} />;
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-2xs text-subtle">{hint}</p>}
    </div>
  );
}

export function NativeSelect({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(inputCls, "pr-6 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 10 10%22><path d=%22M2 4l3 3 3-3%22 fill=%22none%22 stroke=%22%238b8b94%22 stroke-width=%221.3%22/></svg>')] bg-[right_6px_center] bg-no-repeat", className)} {...p} />;
}
