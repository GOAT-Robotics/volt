import { useId } from "react";
import { cn } from "@/lib/utils";

/** Volt mark: a "V" whose right arm is a lightning bolt. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn("shrink-0", className)} aria-hidden="true">
      <defs>
        <linearGradient id={`vg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B73FF" />
          <stop offset="1" stopColor="#1F3BD6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#vg${id})`} />
      <path d="M15.5 15.5 L30.5 47.5 L39 31 H31.5 L48.5 15.5" fill="none" stroke="#fff" strokeWidth="5.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ size = 28, className, subtitle }: { size?: number; className?: string; subtitle?: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} />
      <span className="min-w-0 leading-tight">
        <span className="block font-semibold tracking-tight text-fg" style={{ fontSize: Math.round(size * 0.55) }}>
          Volt
        </span>
        {subtitle && <span className="block truncate text-2xs text-subtle">{subtitle}</span>}
      </span>
    </span>
  );
}
