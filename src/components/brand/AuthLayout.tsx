import { LogoMark } from "./Logo";

export function AuthBrand() {
  return (
    <div className="mb-7 flex flex-col items-center text-center">
      <LogoMark size={48} className="drop-shadow-[0_6px_16px_rgba(37,70,235,0.35)]" />
      <p className="mt-3 text-lg font-semibold tracking-tight">Volt</p>
      <p className="text-xs text-muted">Electrical diagrams & document control</p>
    </div>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_1px_1px,var(--border-strong)_1px,transparent_0)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)] opacity-60" />
      <div className="relative w-full max-w-sm">
        <AuthBrand />
        <div className="rounded-xl border border-border bg-panel p-6 shadow-pop">{children}</div>
      </div>
    </main>
  );
}
