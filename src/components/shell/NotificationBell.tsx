"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Empty } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { relTime, cn } from "@/lib/utils";

type N = { id: string; type: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };

export function NotificationBell() {
  const [items, setItems] = useState<N[]>([]);
  const [unread, setUnread] = useState(0);
  const load = () =>
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : { items: [], unread: 0 }))
      .then((j) => {
        setItems(j.items ?? []);
        setUnread(j.unread ?? 0);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, []);
  const markAll = async () => {
    await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    void load();
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className="relative">
          <Bell />
          {unread > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-danger ring-2 ring-panel" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Notifications</span>
          <Button size="xs" variant="ghost" onClick={markAll} disabled={!unread}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {items.length === 0 && (
            <li>
              <Empty title="You’re all caught up" />
            </li>
          )}
          {items.map((n) => (
            <li key={n.id} className={cn("border-b border-border last:border-0", !n.readAt && "bg-accent-soft/40")}>
              <Link
                href={n.link ?? "#"}
                onClick={() => fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [n.id] }) })}
                className="block px-3 py-2 hover:bg-hover"
              >
                <p className="text-xs font-medium">{n.title}</p>
                {n.body && <p className="line-clamp-2 text-2xs text-muted">{n.body}</p>}
                <p className="mt-0.5 text-2xs text-subtle">{relTime(n.createdAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
