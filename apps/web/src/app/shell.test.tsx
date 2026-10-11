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
    expect(await screen.findByText('ما الذي سيصل إلى حسابك قريبًا')).toBeInTheDocument();
  });

  it('sends anonymous visitors to the Arabic login page', async () => {
    const { router } = await renderAs(null, '/users');
    expect(await screen.findByRole('heading', { name: 'تسجيل الدخول' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});
