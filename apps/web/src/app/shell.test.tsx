import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './App';
import { createTestRouter } from './router';
import { DemoApi } from '../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../api/demo/constants';
import { useAuthStore } from '../stores/auth';

async function renderAs(identifier: string | null, path = '/') {
  const api = new DemoApi({ dbName: `nuzli-shell-${Math.random()}` });
  if (identifier) await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { api, router };
}

describe('RTL app shell', () => {
  it('renders right-to-left with Arabic navigation for an admin', async () => {
    await renderAs('admin1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    for (const label of [
      'الرئيسية',
      'طلبات التسجيل',
      'المستخدمون',
      'سجل التدقيق',
      'الإشعارات',
      'إعدادات النظام',
    ]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(await screen.findByText('طلبات تسجيل بانتظارك')).toBeInTheDocument();
    // No Latin letters in the visible navigation.
    expect(nav.textContent ?? '').not.toMatch(/[A-Za-z]/);
  });

  it('hides admin-only navigation from a monitor (permissions via can())', async () => {
    await renderAs('monitor1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    expect(within(nav).getByText('الرئيسية')).toBeInTheDocument();
    expect(within(nav).queryByText('المستخدمون')).toBeNull();
    expect(within(nav).queryByText('طلبات التسجيل')).toBeNull();
    // Phase 3: the monitor's violation items, and the admin's violation pages stay hidden.
    expect(within(nav).getByText('مخالفاتي')).toBeInTheDocument();
    expect(within(nav).getByText('بانتظار المزامنة')).toBeInTheDocument();
    expect(within(nav).queryByText('لوحة المخالفات')).toBeNull();
    expect(await screen.findByText('أعضاء محفوظون على الجهاز')).toBeInTheDocument();
  });

  it('gives admins the GanttPRO-style side: «+ إنشاء مشروع جديد» and «كل المشاريع» first (A9)', async () => {
    await renderAs('admin1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    const create = within(nav).getByRole('link', { name: 'إنشاء مشروع جديد' });
    expect(create).toHaveAttribute('href', '/projects?create=1');
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent ?? '')
      .filter((x) => x && x !== 'إنشاء مشروع جديد');
    expect(links.slice(1, 7)).toEqual(['كل المشاريع', 'المحافظ', 'مهامي', 'سجل وقتي', 'التقارير', 'عبء العمل']);
    expect(within(nav).getByText('منظومة مُحسن')).toBeInTheDocument();
  });

  it('shows a supervisor «مهامي» first and no project management (A9)', async () => {
    await renderAs('supervisor1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    const first = within(nav).getAllByRole('link').find((a) => a.getAttribute('href') !== '/');
    expect(first).toHaveTextContent('مهامي');
    for (const label of ['كل المشاريع', 'المحافظ', 'التقارير', 'عبء العمل', 'إنشاء مشروع جديد']) {
      expect(within(nav).queryByText(label)).toBeNull();
    }
  });

  it('renders the pages being built with their guard and the «قيد الإنشاء» notice (A9)', async () => {
    await renderAs('admin1@demo.nuzli.example', '/communication');
    expect(await screen.findByRole('heading', { level: 1, name: 'مركز التواصل' })).toBeInTheDocument();
    expect(screen.getByText('قيد الإنشاء — يصل في هذا الإصدار')).toBeInTheDocument();
  });

  it('forbids the pages being built to a monitor', async () => {
    await renderAs('monitor1@demo.nuzli.example', '/reports');
    expect(await screen.findByRole('heading', { name: 'لا تملك صلاحية هذه الصفحة' })).toBeInTheDocument();
  });

  it('sends anonymous visitors to the Arabic login page', async () => {
    const { router } = await renderAs(null, '/users');
    expect(await screen.findByRole('heading', { name: 'تسجيل الدخول إلى نُزلي' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});
