"use client";
import * as React from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import * as C from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

const content = "z-50 min-w-44 rounded-lg border border-border bg-panel p-1 shadow-pop animate-in text-xs";
const item =
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:text-subtle";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export function MenuContent({ className, align = "start", ...p }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={4} align={align} className={cn(content, className)} {...p} />
    </M.Portal>
  );
}
export function MenuItem({ className, danger, shortcut, children, ...p }: React.ComponentProps<typeof M.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <M.Item className={cn(item, danger && "text-danger [&_svg]:text-danger", className)} {...p}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-2xs text-subtle">{shortcut}</span>}
    </M.Item>
  );
}
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-border" />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <M.Label className="px-2 py-1 text-2xs font-medium text-subtle">{children}</M.Label>;
export const MenuSub = M.Sub;
export function MenuSubTrigger({ className, ...p }: React.ComponentProps<typeof M.SubTrigger>) {
  return <M.SubTrigger className={cn(item, className)} {...p} />;
}
export function MenuSubContent({ className, ...p }: React.ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent className={cn(content, className)} {...p} />
    </M.Portal>
  );
}
export function MenuCheckbox({ className, children, ...p }: React.ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn(item, "pl-6", className)} {...p}>
      <M.ItemIndicator className="absolute left-2">✓</M.ItemIndicator>
      {children}
    </M.CheckboxItem>
  );
}

export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;
export function ContextMenuContent({ className, ...p }: React.ComponentProps<typeof C.Content>) {
  return (
    <C.Portal>
      <C.Content className={cn(content, className)} {...p} />
    </C.Portal>
  );
}
export function ContextMenuItem({ className, danger, shortcut, children, ...p }: React.ComponentProps<typeof C.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <C.Item className={cn(item, danger && "text-danger [&_svg]:text-danger", className)} {...p}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-2xs text-subtle">{shortcut}</span>}
    </C.Item>
  );
}
export const ContextMenuSeparator = () => <C.Separator className="my-1 h-px bg-border" />;
