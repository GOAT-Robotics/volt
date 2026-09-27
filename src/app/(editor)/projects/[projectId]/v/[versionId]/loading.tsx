import { LogoMark } from "@/components/brand/Logo";

/** Shown the moment a drawing is opened, while the server checks access. */
export default function Loading() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg">
      <LogoMark size={36} className="animate-pulse" />
      <p className="text-xs text-muted">Opening drawing…</p>
    </div>
  );
}
