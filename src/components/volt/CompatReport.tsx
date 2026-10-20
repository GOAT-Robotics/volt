"use client";
import * as React from "react";
import { CheckCircle2, AlertTriangle, Archive, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CompatItem, CompatLevel, CompatReport } from "@/core/model";

const LEVELS: { level: CompatLevel; label: string; icon: React.ReactNode; cls: string; help: string }[] = [
  { level: "supported", label: "Supported", icon: <CheckCircle2 />, cls: "text-success", help: "Imported and fully editable." },
  { level: "degraded", label: "Degraded", icon: <AlertTriangle />, cls: "text-warning", help: "Imported with simplifications — check these areas." },
  { level: "preserved", label: "Preserved", icon: <Archive />, cls: "text-accent", help: "Not editable in Volt, kept byte-for-byte and written back on .qet export." },
  { level: "unsupported", label: "Unsupported", icon: <XCircle />, cls: "text-danger", help: "Not represented; still kept in the stored original file." },
];

/** the same four levels, worded for .volt files (Volt's own format: nothing is lost, some things become records) */
const VOLT_TEXT: Record<CompatLevel, { label: string; help: string }> = {
  supported: { label: "Imported", help: "Comes in as it was." },
  degraded: { label: "Check", help: "Worth a look before you rely on it." },
  preserved: { label: "Kept as record", help: "Read-only history from the file; it does not count as an approval or signature here." },
  unsupported: { label: "Not imported", help: "Left out — the original file is stored unchanged." },
};

/** what an import kept, simplified, preserved or left out (QElectroTech .qet and Volt .volt files) */
export function CompatReportView({ report }: { report: CompatReport }) {
  const volt = report.qetVersion.startsWith("volt");
  const groups = LEVELS.map((l) => ({ ...l, ...(volt ? VOLT_TEXT[l.level] : {}), items: report.items.filter((i) => i.level === l.level) }));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        {groups.map((g) => (
          <div key={g.level} className="rounded-md border border-border bg-panel-2 px-2.5 py-2">
            <p className={cn("flex items-center gap-1 text-2xs font-medium [&_svg]:size-3", g.cls)}>
              {g.icon} {g.label}
            </p>
            <p className="text-base font-semibold tabular-nums">{g.items.length}</p>
          </div>
        ))}
      </div>
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <details key={g.level} open={g.level !== "supported"} className="rounded-md border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs font-medium">
              <span className={cn("[&_svg]:size-3.5", g.cls)}>{g.icon}</span>
              {g.label} <span className="text-muted">— {g.help}</span>
            </summary>
            <ul className="border-t border-border px-3 py-1.5">
              {g.items.map((i: CompatItem, k) => (
                <li key={k} className="flex gap-2 py-0.5 text-2xs">
                  <span className="w-24 shrink-0 font-medium text-muted">{i.area}</span>
                  <span className="flex-1">{i.message}</span>
                  {i.count !== undefined && <span className="tabular-nums text-muted">×{i.count}</span>}
                  {i.page && <span className="text-muted">{i.page}</span>}
                </li>
              ))}
            </ul>
          </details>
        ))}
    </div>
  );
}

