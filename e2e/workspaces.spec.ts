/**
 * A12 (owner request 2026-10-20) — workspaces end to end on the demo build (in-browser DemoApi,
 * isolated per workspace exactly like the server): the owner creates a second workspace and its
 * admin, switches into the empty workspace and back (data intact), a user created with a first
 * password must change it, and single-workspace mode looks as before.
 * Playwright is not installed in this repository yet — see playwright.config.ts. The same flow is
 * exercised by `apps/web/src/features/workspaces/workspaces.test.tsx` and
 * `apps/web/src/api/demo/isolation.test.ts` (Vitest).
 */
import { expect, test, type Page } from '@playwright/test';

async function demoLogin(page: Page, identifier: string, password = 'NuzliDemo2026') {
  await page.goto('./login');
  await page.getByLabel('اسم المستخدم أو البريد أو الجوال').fill(identifier);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
}

test('single-workspace mode: the name under the logo, no picker, no switcher', async ({ page }) => {
  await demoLogin(page, 'admin1');
  await expect(page.getByTestId('ws-name')).toHaveText('إدارة المشاريع');
  await page.getByRole('button', { name: 'قائمة الحساب' }).click();
  await expect(page.getByText('الأقسام', { exact: true })).toHaveCount(0);
});

test('owner: a second workspace is empty and isolated; switching back keeps the data', async ({ page }) => {
  await demoLogin(page, 'mmansary');
  await page.goto('./system/workspaces');
  await page.getByTestId('ws-create').click();
  await page.getByTestId('ws-name-input').fill('قسم الصيانة');
  await page.getByTestId('ws-create-submit').click();
  await expect(page.getByText('قسم الصيانة')).toBeVisible();

  await page.getByRole('button', { name: 'قائمة الحساب' }).click();
  await page.getByTestId('ws-switch-ws-2').click();
  await expect(page.getByTestId('ws-name')).toHaveText('قسم الصيانة');
  await page.goto('./teams');
  await expect(page.getByText('فريق الصيانة الميدانية')).toHaveCount(0);

  await page.getByRole('button', { name: 'قائمة الحساب' }).click();
  await page.getByTestId('ws-switch-projects').click();
  await page.goto('./teams');
  await expect(page.getByText('فريق الصيانة الميدانية')).toBeVisible();
});

test('a user created with a first password must change it at first sign-in', async ({ page }) => {
  await demoLogin(page, 'admin1');
  await page.goto('./users');
  await page.getByTestId('user-create').click();
  await page.getByTestId('user-username').fill('e2e.user');
  await page.getByLabel('الاسم الكامل').fill('مستخدم الاختبار');
  await page.getByLabel('البريد الإلكتروني').fill('e2e.user@example.com');
  await page.getByLabel('رقم الجوال').fill('0558990001');
  await page.getByLabel('رقم الهوية').fill('1066998871');
  await page.getByTestId('user-password').fill('E2e-First-Pass-2026');
  await page.getByTestId('user-create-submit').click();
  await page.getByRole('button', { name: 'قائمة الحساب' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await demoLogin(page, 'e2e.user', 'E2e-First-Pass-2026');
  await expect(page).toHaveURL(/change-password/);
});
