"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Library, Inbox, Search, Settings, Moon, Sun, Monitor, LogOut, ChevronsUpDown, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Avatar, TooltipProvider } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { NotificationBell } from "./NotificationBell";
import { Toaster } from "sonner";
import { LogoMark } from "@/components/brand/Logo";
import { signOutAction } from "@/app/actions/auth";

export type ShellUser = { name: string; email: string; roles: string[]; isAdmin: boolean; workspace: string; workspaces: { id: string; name: string }[]; workspaceId: string };

export function AppShell({ user, children, inboxCount }: { user: ShellUser; children: React.ReactNode; inboxCount: number }) {
  const path = usePathname();
  const nav = [
    { href: "/projects", label: "Projects", icon: <FolderKanban /> },
    { href: "/library", label: "Library", icon: <Library /> },
    { href: "/reviews", label: "My reviews", icon: <Inbox />, badge: inboxCount },
    { href: "/search", label: "Search", icon: <Search /> },
    ...(user.isAdmin ? [{ href: "/admin", label: "Administration", icon: <Settings /> }, { href: "/admin/audit", label: "Audit log", icon: <ScrollText /> }] : []),
  ];
  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-dvh overflow-hidden">
        <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-panel">
          <div className="flex h-12 items-center gap-2 px-3">
            <LogoMark size={28} />
            <Menu>
              <MenuTrigger asChild>
                <button className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold leading-tight">Volt</span>
                    <span className="block truncate text-2xs leading-tight text-subtle">{user.workspace}</span>
                  </span>
                  <ChevronsUpDown className="size-3 text-subtle" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Workspaces</MenuLabel>
                {user.workspaces.map((w) => (
                  <MenuItem
                    key={w.id}
                    onSelect={() => {
                      document.cookie = `volt_ws=${w.id}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
                      location.href = "/projects";
                    }}
                  >
                    {w.id === user.workspaceId ? "✓ " : ""}
                    {w.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
          <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Main">
            {nav.map((n) => {
              const active = n.href === "/admin" ? path === "/admin" || (path.startsWith("/admin/") && !path.startsWith("/admin/audit")) : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-xs [&_svg]:size-3.5", active ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}
                  aria-current={active ? "page" : undefined}
                >
                  {n.icon}
                  {n.label}
                  {"badge" in n && n.badge ? <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">{n.badge}</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-border p-2">
            <UserMenu user={user} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-end gap-2 border-b border-border bg-panel px-4">
            <form action="/search" className="relative mr-auto w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
              <input name="q" placeholder="Search projects, components, pins, labels…" className="h-8 w-full rounded-md border border-border bg-panel-2 pl-8 pr-2 text-xs outline-none placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20" aria-label="Search" />
            </form>
            <NotificationBell />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <Toaster position="bottom-right" toastOptions={{ className: "!text-xs !rounded-lg !border-border !bg-panel !text-fg" }} />
    </TooltipProvider>
  );
}

function UserMenu({ user }: { user: ShellUser }) {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  useEffect(() => {
    try {
      setTheme((localStorage.getItem("volt-theme") as typeof theme) ?? "system");
    } catch {}
  }, []);
  const apply = (t: typeof theme) => {
    setTheme(t);
    try {
      localStorage.setItem("volt-theme", t);
    } catch {}
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-hover">
          <Avatar name={user.name} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{user.name}</span>
            <span className="block truncate text-2xs text-subtle">{user.roles.join(", ").toLowerCase()}</span>
          </span>
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-56">
        <MenuLabel>{user.email}</MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => apply("light")}>
          <Sun /> Light {theme === "light" && "✓"}
        </MenuItem>
        <MenuItem onSelect={() => apply("dark")}>
          <Moon /> Dark {theme === "dark" && "✓"}
        </MenuItem>
        <MenuItem onSelect={() => apply("system")}>
          <Monitor /> System {theme === "system" && "✓"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void signOutAction()}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="border-b border-border bg-panel px-6 py-4">
      {breadcrumb && <div className="mb-1 text-2xs text-subtle">{breadcrumb}</div>}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
