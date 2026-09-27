/**
 * Server start hook: installs / tops up the standard element library and the standard style and
 * project templates in the background, so a fresh deployment needs no manual seeding step.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VOLT_SKIP_STANDARD_LIBRARY === "1") return;
  setTimeout(() => {
    import("@/lib/standard-templates")
      .then((m) => m.ensureStandardTemplatesEverywhere((msg) => console.log(`[volt] ${msg}`)))
      .catch((e) => console.error("[volt] standard templates install failed:", e));
    import("@/lib/library/standard")
      .then((m) => m.ensureStandardLibraryEverywhere((msg) => console.log(`[volt] ${msg}`)))
      .catch((e) => console.error("[volt] standard library install failed:", e));
  }, 1500);
}
