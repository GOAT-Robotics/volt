/**
 * Server start hook: installs / tops up the standard element library in the background so a fresh
 * deployment has the full symbol collection without any manual seeding step.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VOLT_SKIP_STANDARD_LIBRARY === "1") return;
  setTimeout(() => {
    import("@/lib/library/standard")
      .then((m) => m.ensureStandardLibraryEverywhere((msg) => console.log(`[volt] ${msg}`)))
      .catch((e) => console.error("[volt] standard library install failed:", e));
  }, 1500);
}
