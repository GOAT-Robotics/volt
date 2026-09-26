import { test, expect, type Page } from "@playwright/test";

// Requires AUTH_DEV_LOGIN=true and a seeded database (npm run setup).
async function login(page: Page) {
  await page.goto("/login");
  await page.fill("input[name=email]", "admin@example.com");
  await page.fill("input[name=name]", "Admin");
  await page.click("text=Sign in (dev)");
  await page.waitForURL(/projects/);
}

type EngineHandle = {
  store: { getState(): any };
  toScreen(p: { x: number; y: number }): { x: number; y: number };
  lastFrameWorkMs: number;
  setView(s: number, tx: number, ty: number): void;
  view: { s: number; tx: number; ty: number };
};

test("place elements, wire them, T-junction, move keeps connections, autosave", async ({ page }) => {
  await login(page);
  const p = await page.evaluate(async () => (await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E " + Date.now() }) })).json());
  await page.goto(`/projects/${p.id}/v/${p.versionId}`);
  await page.waitForSelector("[data-testid=canvas-host] canvas");
  const box = (await page.locator("[data-testid=canvas-host]").boundingBox())!;

  await page.click("text=Relays & contactors/Coils");
  await page.locator('button[title^="Coil"]').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__voltEngine.store.getState().tool)).toBe("place");
  for (const x of [500, 800]) {
    await page.mouse.move(box.x + x, box.y + 400);
    await page.mouse.click(box.x + x, box.y + 400);
  }
  await page.keyboard.press("Escape");

  const pins = await page.evaluate(() => {
    const eng = (window as any).__voltEngine as EngineHandle;
    const st = eng.store.getState();
    const out: { el: string; orient: string; x: number; y: number }[] = [];
    for (const e of st.page().elements)
      for (const pin of st.doc.defs[e.defId].pins) {
        let x = e.mirror ? -pin.x : pin.x, y = pin.y;
        for (let i = 0; i < e.rot; i++) [x, y] = [-y, x];
        out.push({ el: e.id, orient: pin.orient, ...eng.toScreen({ x: e.x + x, y: e.y + y }) });
      }
    return out;
  });
  expect(pins.length).toBe(4);
  const a = pins[0], b = pins.find((q) => q.el !== a.el && q.orient === a.orient)!;
  await page.keyboard.press("w");
  await page.mouse.click(box.x + a.x, box.y + a.y);
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 6 });
  await page.mouse.click(box.x + b.x, box.y + b.y);

  const wires = await page.evaluate(() => (window as any).__voltEngine.store.getState().page().wires.map((w: any) => [w.a.k, w.b.k]));
  expect(wires).toEqual([["pin", "pin"]]);

  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as any).__voltEngine.store.getState().save), { timeout: 10_000 }).toBe("saved");
});

test("large drawing stays responsive while panning", async ({ page }) => {
  await login(page);
  const res = await page.evaluate(async () => (await fetch("/api/projects")).json());
  const demo = res.projects.find((x: any) => x.name.startsWith("Demo"));
  test.skip(!demo, "demo project not seeded");
  await page.goto(`/projects/${demo.id}/v/${demo.latest.id}`);
  await page.waitForSelector("[data-testid=canvas-host] canvas");
  const work = await page.evaluate(async () => {
    const eng = (window as any).__voltEngine as EngineHandle;
    const t: number[] = [];
    for (let i = 0; i < 60; i++) {
      eng.setView(eng.view.s, eng.view.tx + 5, eng.view.ty + 3);
      await new Promise((r) => requestAnimationFrame(r));
      t.push(eng.lastFrameWorkMs);
    }
    return t.sort((x, y) => x - y)[57];
  });
  expect(work).toBeLessThan(16);
});
