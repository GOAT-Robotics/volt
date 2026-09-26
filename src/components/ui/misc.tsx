"use client";
import * as React from "react";
import * as T from "@radix-ui/react-tooltip";
import * as P from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import * as Sw from "@radix-ui/react-switch";
import * as Cb from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const TooltipProvider = T.Provider;
export function Tip({ content, children, side = "bottom", shortcut }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; shortcut?: string }) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-[60] flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-2xs text-bg shadow-float animate-in">
          {content}
          {shortcut && <kbd className="rounded bg-white/15 px-1 font-mono text-[10px]">{shortcut}</kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export function PopoverContent({ className, align = "start", ...p }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={6} className={cn("z-50 rounded-lg border border-border bg-panel p-3 shadow-pop outline-none animate-in", className)} {...p} />
    </P.Portal>
  );
}

export const TabsRoot = Tabs.Root;
export function TabsList({ className, ...p }: React.ComponentProps<typeof Tabs.List>) {
  return <Tabs.List className={cn("flex items-center gap-0.5 border-b border-border", className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof Tabs.Trigger>) {
  return (
    <Tabs.Trigger
      className={cn(
        "relative -mb-px h-8 border-b-2 border-transparent px-2.5 text-xs font-medium text-muted outline-none transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
      {...p}
    />
  );
}
export const TabsContent = Tabs.Content;

export function Switch({ className, ...p }: React.ComponentProps<typeof Sw.Root>) {
  return (
    <Sw.Root className={cn("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50", className)} {...p}>
      <Sw.Thumb className="block size-3 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-3.5" />
    </Sw.Root>
  );
}

export function Checkbox({ className, ...p }: React.ComponentProps<typeof Cb.Root>) {
  return (
    <Cb.Root className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border-strong bg-panel data-[state=checked]:border-accent data-[state=checked]:bg-accent", className)} {...p}>
      <Cb.Indicator>
        <Check className="size-2.5 text-white" strokeWidth={3} />
      </Cb.Indicator>
    </Cb.Root>
  );
}

const badgeTones = {
  neutral: "bg-hover text-muted border-border",
  accent: "bg-accent-soft text-accent border-accent/20",
  success: "bg-success-soft text-success border-success/20",
  warning: "bg-warning-soft text-warning border-warning/25",
  danger: "bg-danger-soft text-danger border-danger/20",
  purple: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
} as const;
export type Tone = keyof typeof badgeTones;
export function Badge({ tone = "neutral", className, children, dot }: { tone?: Tone; className?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-2xs font-medium", badgeTones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-panel-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Avatar({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("");
  return (
    <span
      title={name}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 55% 50%)` }}
    >
      {ini}
    </span>
  );
}

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-panel", className)} {...p} />;
}
export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border px-4 py-2.5", className)}>
      <div className="min-w-0">
        <h3 className="text-xs font-semibold">{title}</h3>
        {description && <p className="text-2xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 rounded-xl border border-border bg-panel-2 p-2.5 text-subtle [&_svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-sm text-xs text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} aria-label="Loading" />;
}

export function Separator({ vertical, className }: { vertical?: boolean; className?: string }) {
  return <div role="separator" className={cn(vertical ? "mx-1 h-4 w-px" : "my-2 h-px w-full", "bg-border", className)} />;
}

export function Table({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-xs [&_th]:h-8 [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:text-left [&_th]:text-2xs [&_th]:font-medium [&_th]:text-subtle [&_td]:h-9 [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-panel-2", className)} {...p} />;
}
