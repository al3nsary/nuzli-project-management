/**
 * A12 (owner request 2026-10-20) — phones «كالسيف» and the installable app, on the demo build at
 * 360×740 (project `mobile-360`): the five-tab bar per role, «المزيد», the phone home with its «+»,
 * the project overview with the full-screen Gantt, the install guide, and the manifest.
 * Playwright is not installed in this repository yet — see playwright.config.ts. The same checks run
 * in Vitest (`apps/web/src/app/mobile.test.tsx`, `src/app/pwa/pwa.test.tsx`) and in headless Chrome
 * (`apps/web/scripts/qa-mobile.mjs`, and `qa-update.mjs` for the update between two builds).
 */
import { expect, test, type Page } from '@playwright/test';

async function demoLogin(page: Page, identifier: string, password = 'NuzliDemo2026') {
  await page.goto('./login');
  await page.getByLabel('اسم المستخدم أو البريد أو الجوال').fill(identifier);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
}

const bar = (page: Page) => page.getByRole('navigation', { name: 'الشريط السفلي' });

test('admin: five tabs, the phone home KPIs and the «+» sheet', async ({ page }) => {
  await demoLogin(page, 'admin1@demo.nuzli.example');
  await expect(bar(page).getByRole('link')).toHaveText(['الرئيسية', 'المشاريع', 'التواصل', /الفرق/, /المزيد/]);
  for (const id of ['projects', 'active', 'teams', 'requests']) await expect(page.getByTestId(`kpi-${id}`)).toBeVisible();
  await page.getByTestId('fab').click();
  await expect(page.getByRole('link', { name: /مشروع جديد/ })).toBeVisible();
  // No horizontal scroll at 360px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('monitor: the raised «تسجيل مخالفة» in the middle of the bar', async ({ page }) => {
  await demoLogin(page, 'monitor1@demo.nuzli.example');
  await expect(bar(page).getByRole('link')).toHaveText(['الرئيسية', 'مخالفاتي', 'تسجيل مخالفة', /بانتظار المزامنة/, /المزيد/]);
  await bar(page).getByRole('link', { name: 'تسجيل مخالفة' }).click();
  await expect(page).toHaveURL(/violations\/new/);
});

test('«المزيد»: version, «البحث عن تحديث», theme and sign-out', async ({ page }) => {
  await demoLogin(page, 'supervisor1@demo.nuzli.example');
  await bar(page).getByRole('link', { name: /المزيد/ }).click();
  await expect(page.getByTestId('more-version')).toContainText('الإصدار');
  await expect(page.getByTestId('more-check')).toContainText('البحث عن تحديث');
  await expect(page.getByTestId('more-logout')).toBeVisible();
});

test('project overview → «عرض المخطط» opens the Gantt full screen; back returns', async ({ page }) => {
  await demoLogin(page, 'admin1@demo.nuzli.example');
  await page.goto('./projects');
  await page.locator('.nz-pc-body').first().click();
  await page.getByTestId('show-gantt').click();
  await expect(page.getByTestId('gantt-full')).toBeVisible();
  await page.getByRole('button', { name: 'العودة إلى المشروع' }).click();
  await expect(page.getByTestId('show-gantt')).toBeVisible();
});

test('install: the manifest is Arabic, RTL, standalone, with shortcuts and screenshots; the iPhone guide', async ({ page, request }) => {
  const manifest = await (await request.get('./manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'نُزلي', lang: 'ar', dir: 'rtl', display: 'standalone' });
  expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual(['تسجيل مخالفة', 'مهامي', 'المشاريع']);
  expect(manifest.screenshots.map((s: { form_factor: string }) => s.form_factor)).toEqual(['narrow', 'narrow', 'wide']);
  await page.goto('./install');
  await expect(page.getByRole('heading', { level: 1, name: 'أضف نُزلي إلى الشاشة الرئيسية' })).toBeVisible();
  await expect(page.getByText('اضغط زر المشاركة')).toBeVisible();
});
