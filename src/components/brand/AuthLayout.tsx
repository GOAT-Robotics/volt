import { LogoMark } from "./Logo";
import { schematicArt } from "@/lib/brand/schematic";

const COMPANY = "Example Company";

/* rendered once per server process: the art is deterministic */
const ART_W = 1600, ART_H = 1000;
let art: string | null = null;
const schematic = () => (art ??= schematicArt({ width: ART_W, height: ART_H, seed: 11, flowClass: "volt-flow", stroke: 1.1 }));

export function AuthBrand() {
  return (
    <div className="mb-7 flex flex-col items-center text-center">
      <LogoMark size={48} className="drop-shadow-[0_6px_16px_rgba(37,70,235,0.35)]" />
      <p className="mt-3 text-lg font-semibold tracking-tight">Volt</p>
      <p className="text-xs text-muted">Electrical diagrams & document control</p>
    </div>
  );
}

/** black-and-white schematic behind the sign-in card */
function SchematicBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 select-none">
      <svg
        className="absolute inset-0 h-full w-full text-black opacity-[0.3] dark:text-white dark:opacity-[0.24]"
        viewBox={`0 0 ${ART_W} ${ART_H}`}
        preserveAspectRatio="xMidYMid slice"
        dangerouslySetInnerHTML={{ __html: schematic() }}
      />
      {/* keep the middle calm so the form reads well */}
      <div className="absolute inset-0 [background:radial-gradient(ellipse_46%_62%_at_50%_52%,#fff_35%,rgba(255,255,255,0.75)_60%,transparent_100%)] dark:[background:radial-gradient(ellipse_46%_62%_at_50%_52%,#000_35%,rgba(0,0,0,0.75)_60%,transparent_100%)]" />
    </div>
  );
}

export function AuthFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative mt-8 flex flex-col items-center gap-2 text-center">
      <a href="https://www.example.com" target="_blank" rel="noopener noreferrer" className="rounded focus-visible:outline-2 focus-visible:outline-offset-4" aria-label={`${COMPANY} (opens in a new tab)`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.png" alt="Example Company" width={96} height={50} className="h-[50px] w-auto dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-dark.png" alt="Example Company" width={96} height={50} className="hidden h-[50px] w-auto dark:block" />
      </a>
      <p className="text-2xs text-muted">
        © {year} {COMPANY}. All rights reserved.
      </p>
      <p className="max-w-xs text-2xs text-subtle">Volt is developed by Example Company for its electrical engineering teams.</p>
    </footer>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-white p-4 text-fg dark:bg-black">
      <SchematicBackdrop />
      <div className="relative w-full max-w-sm">
        <AuthBrand />
        <div className="rounded-xl border border-border bg-panel p-6 shadow-pop">{children}</div>
      </div>
      <AuthFooter />
    </main>
  );
}
