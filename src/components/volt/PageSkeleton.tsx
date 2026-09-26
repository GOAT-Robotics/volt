/** Loading placeholder used by route-level loading.tsx files. */
export function PageSkeleton({ rows = 6, tabs = false }: { rows?: number; tabs?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="border-b border-border bg-panel px-6 py-4">
        <div className="h-4 w-48 animate-pulse rounded bg-hover" />
        <div className="mt-2 h-3 w-80 animate-pulse rounded bg-hover" />
      </div>
      {tabs && (
        <div className="flex gap-4 border-b border-border bg-panel px-6 py-2.5">
          {[60, 56, 70, 52, 64].map((w, i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-hover" style={{ width: w }} />
          ))}
        </div>
      )}
      <div className="space-y-2 p-6">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3">
            <div className="size-5 animate-pulse rounded-full bg-hover" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 animate-pulse rounded bg-hover" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
              <div className="h-2.5 w-1/4 animate-pulse rounded bg-hover" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
