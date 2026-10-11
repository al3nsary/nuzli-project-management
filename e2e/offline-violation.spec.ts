/**
 * Brief §14 / §16 Phase 3: an offline violation is recorded, the page reloads in airplane mode,
 * the connection returns, and the violation syncs exactly once.
 * Runs against the demo build (DemoApi simulates the network while the browser is offline).
 * Playwright is not installed in this repository yet — see playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';

/** A small real JPEG (made in the page with a canvas) for the file inputs. */
async function jpeg(page: Page, label: string): Promise<Buffer> {
  const b64 = await page.evaluate(async (text) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 900;
    const x = c.getContext('2d')!;
    x.fillStyle = '#8fb8bb';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#14232b';
    x.font = '96px sans-serif';
    x.fillText(text, 80, 450);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
    return btoa(s);
  }, label);
  return Buffer.from(b64, 'base64');
}

async function pick(page: Page, name: string) {
  await page.locator('input[type=file]').first().setInputFiles({
    name: `${name}.jpg`,
    mimeType: 'image/jpeg',
    buffer: await jpeg(page, name),
  });
}

/** Rows of the demo "server" with these client UUIDs (DemoApi keeps them in IndexedDB). */
function serverRows(page: Page, ids: string[]) {
  return page.evaluate(async (wanted) => {
    const open = indexedDB.open('nuzli-demo');
    const db: IDBDatabase = await new Promise((r) => (open.onsuccess = () => r(open.result)));
    const all = <T,>(store: string): Promise<T[]> =>
      new Promise((r) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => r(q.result as T[]);
      });
    const v = await all<{ id: string; clientUuid: string; latitude: number; longitude: number; teamIdSnapshot: string | null }>('violations');
    const f = await all<{ violationId: string | null; status: string }>('files');
    return v
      .filter((x) => wanted.includes(x.clientUuid))
      .map((x) => ({
        lat: x.latitude,
        lng: x.longitude,
        team: x.teamIdSnapshot,
        photos: f.filter((y) => y.violationId === x.id && y.status === 'READY').length,
      }));
  }, ids);
}

function outboxIds(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('nuzli-offline');
    const db: IDBDatabase = await new Promise((r) => (open.onsuccess = () => r(open.result)));
    return new Promise<{ id: string; status: string }[]>((r) => {
      const q = db.transaction('outbox').objectStore('outbox').getAll();
      q.onsuccess = () => r((q.result as { id: string; status: string }[]).map((i) => ({ id: i.id, status: i.status })));
    });
  });
}

test('offline violation: record → reload → online → synced once', async ({ page, context }) => {
  // Sign in as the demo monitor; the roster downloads on login.
  await page.goto('login');
  await page.getByRole('button', { name: 'دخول تجريبي بصفة مشرف مراقبة' }).click();
  await expect(page.getByText('أعضاء محفوظون على الجهاز')).toBeVisible();
  await expect(page.getByText('لم تُحمَّل قائمة الأعضاء على هذا الجهاز بعد.')).toHaveCount(0);

  // The service worker must control the page before the connection drops.
  await page.goto('violations/new');
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
  await expect(page.getByText(/حُدّد الموقع بدقة/)).toBeVisible();

  // Airplane mode.
  await context.setOffline(true);
  await expect(page.getByText('غير متصل').first()).toBeVisible();

  // 1. Member from the cached roster (masked ID + team).
  await page.getByLabel('ابحث عن العضو').fill('احمد');
  const row = page.locator('.nz-roster-row').first();
  await expect(row).toContainText('•');
  await row.click();
  await page.getByRole('button', { name: 'التالي' }).click();
  // 2. ID card, 3. evidence
  await pick(page, 'id-card');
  await expect(page.locator('.nz-thumb img')).toHaveCount(1);
  await page.getByRole('button', { name: 'التالي' }).click();
  await pick(page, 'evidence-1');
  await expect(page.locator('.nz-thumb img')).toHaveCount(1);
  await pick(page, 'evidence-2');
  await expect(page.locator('.nz-thumb img')).toHaveCount(2);
  await page.getByRole('button', { name: 'التالي' }).click();
  // 4. Type + description
  await page.locator('.nz-type-card').first().click();
  await page.getByLabel('وصف المخالفة').fill('رُصد العضو دون السترة العاكسة (اختبار آلي).');
  await page.getByRole('button', { name: 'حفظ المخالفة' }).click();
  await expect(page.getByText('حُفظت المخالفة — ستُرسل عند توفّر الاتصال')).toBeVisible();

  const [item] = await outboxIds(page);
  expect(item?.status).not.toBe('synced');

  // Reload while offline: the shell comes from the service worker, the outbox from IndexedDB.
  await page.goto('violations/pending');
  await page.reload();
  await expect(page.getByText('بانتظار الاتصال')).toBeVisible();
  await expect(page.locator('.nz-bottombar-badge')).toHaveText('1');
  expect(await serverRows(page, [item!.id])).toHaveLength(0);

  // Back online: the `online` event runs the sync.
  await context.setOffline(false);
  await expect(page.getByText('أُرسلت')).toBeVisible({ timeout: 30_000 });
  // A second trigger must not duplicate anything.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1500);

  const rows = await serverRows(page, [item!.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.lat).toBeCloseTo(24.71361, 4);
  expect(rows[0]!.lng).toBeCloseTo(46.67531, 4);
  expect(rows[0]!.team).not.toBeNull();
  expect(rows[0]!.photos).toBe(3); // ID card + 2 evidence photos
});
