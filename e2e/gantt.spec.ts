/**
 * Brief §16 Phase 4 acceptance, in a real browser against the demo build (DemoApi):
 * dragging a Gantt bar to the LEFT (later, RTL) moves it and shifts its finish-to-start
 * successor over working days; both are persisted with a new version; a 2,000-task project
 * renders a bounded number of rows.
 * Playwright is not installed in this repository yet — see playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';

const PARK = '00000000-0000-4000-8000-f00000000001';
const LARGE = '00000000-0000-4000-8000-f00000000003';
/** Seed (seed/demo/projects.json): «تسوير الموقع» → FS → «توصيل الكهرباء المؤقتة». */
const FENCE = '00000000-0000-4000-8000-d10000000007';
const POWER = '00000000-0000-4000-8000-d10000000011';

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

async function loginAsAdmin(page: Page) {
  await page.goto('login');
  await page.getByRole('button', { name: /دخول تجريبي.*مدير النظام/ }).click();
  await expect(page).not.toHaveURL(/login/);
}

/** A task row as the demo "server" stores it (IndexedDB `nuzli-demo`, table `tasks`). */
function stored(page: Page, id: string) {
  return page.evaluate(async (taskId) => {
    const open = indexedDB.open('nuzli-demo');
    const db: IDBDatabase = await new Promise((r) => (open.onsuccess = () => r(open.result)));
    return new Promise<{ startDate: string; endDate: string; version: number }>((resolve) => {
      const q = db.transaction('tasks').objectStore('tasks').get(taskId);
      q.onsuccess = () => resolve(q.result);
    });
  }, id);
}

const bar = (page: Page, id: string) => page.locator(`[data-gantt-svg] g[data-task-id="${id}"] rect`).first();

test('dragging a bar left delays it and shifts its FS successor (RTL)', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`projects/${PARK}`);
  await page.getByRole('radio', { name: 'أسبوع' }).check({ force: true });
  await expect(bar(page, FENCE)).toBeVisible();
  const beforeA = await stored(page, FENCE);
  const beforeB = await stored(page, POWER);
  const a0 = (await bar(page, FENCE).boundingBox())!;
  const b0 = (await bar(page, POWER).boundingBox())!;

  // Week zoom = 14 px per day: 70 px to the LEFT is 5 calendar days LATER.
  await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a0.x + a0.width / 2 - i * 7, a0.y + a0.height / 2);
  // The local engine preview already moved the successor before the drop.
  await expect.poll(async () => (await bar(page, POWER).boundingBox())!.x).toBeLessThan(b0.x);
  await page.mouse.up();

  await expect.poll(async () => (await stored(page, FENCE)).version).toBe(beforeA.version + 1);
  const afterA = await stored(page, FENCE);
  const afterB = await stored(page, POWER);
  expect(afterA.startDate > beforeA.startDate).toBe(true);
  expect(afterB.startDate > beforeB.startDate).toBe(true);
  // FS: the successor starts after the predecessor ends, never on Friday or Saturday.
  expect(afterB.startDate > afterA.endDate).toBe(true);
  for (const d of [afterA.startDate, afterB.startDate]) expect([5, 6]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  // Later dates sit further LEFT.
  expect((await bar(page, FENCE).boundingBox())!.x).toBeLessThan(a0.x);
});

test('Alt+← on a focused row moves the task one working day later', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`projects/${PARK}`);
  const before = await stored(page, POWER);
  // Click the WBS cell (the name cell opens the editor).
  await page.getByRole('row').filter({ hasText: 'توصيل الكهرباء المؤقتة' }).getByRole('gridcell').first().click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => (await stored(page, POWER)).version).toBe(before.version + 1);
  expect((await stored(page, POWER)).startDate > before.startDate).toBe(true);
});

test('a 2,000-task project renders a bounded window of rows', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`projects/${LARGE}`);
  await expect(page.locator('[data-bar]').first()).toBeVisible();
  const rows = await page.locator('[data-row]').count();
  expect(rows).toBeGreaterThan(10);
  expect(rows).toBeLessThan(60);
  await page.locator('[data-testid=gantt-body]').evaluate((el) => (el.scrollTop = 36 * 1500));
  await expect(page.locator('[data-row-index="1500"]')).toBeAttached();
  expect(await page.locator('[data-row]').count()).toBeLessThan(60);
});
