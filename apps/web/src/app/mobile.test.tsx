/**
 * A12 — phones and tablets: the five-tab bottom bar per role, «المزيد», the KPI cards of the phone
 * home per role, the floating «+», the keyboard inset that keeps sticky form buttons visible, and
 * the tablet rail default. The viewport is emulated with a query-aware matchMedia (phone 390px).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './App';
import { createTestRouter } from './router';
import { DemoApi } from '../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../api/demo/constants';
import { useAuthStore } from '../stores/auth';
import { keyboardInset, useKeyboardInset } from './shell/viewport';
import { selectMini, useShellStore } from './shell/store';
import { tabsFor } from './shell/tabs';
import { visibleNav } from './nav';
import { renderHook } from '@testing-library/react';

const T = { timeout: 10_000 };
const ADMIN = 'admin1@demo.nuzli.example';
const SUP = 'supervisor1@demo.nuzli.example';
const MON = 'monitor1@demo.nuzli.example';

/** A viewport `width` px wide: answers min/max-width media queries like a browser would. */
function emulateWidth(width: number) {
  const em = (v: string) => (v.endsWith('em') ? parseFloat(v) * 16 : parseFloat(v));
  window.matchMedia = ((query: string) => {
    let matches = true;
    for (const m of query.matchAll(/\((min|max)-width:\s*([\d.]+(?:em|px))\)/g)) {
      const v = em(m[2]!);
      if (m[1] === 'min' && width < v) matches = false;
      if (m[1] === 'max' && width > v) matches = false;
    }
    if (!/width/.test(query)) matches = false;
    return { matches, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => emulateWidth(390));
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

async function renderAs(identifier: string, path = '/') {
  const api = new DemoApi({ dbName: `nuzli-mobile-${Math.random()}` });
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { api, router };
}

async function tabLabels() {
  const bar = await screen.findByRole('navigation', { name: 'الشريط السفلي' }, T);
  return { bar, labels: within(bar).getAllByRole('link').map((a) => a.textContent ?? '') };
}

describe('A12 bottom bar — five tabs per role', () => {
  it('admin: الرئيسية · المشاريع · التواصل · الفرق · المزيد, the active tab filled', async () => {
    await renderAs(ADMIN);
    const { bar, labels } = await tabLabels();
    expect(labels).toEqual(['الرئيسية', 'المشاريع', 'التواصل', 'الفرق', 'المزيد']);
    expect(within(bar).getByRole('link', { name: 'الرئيسية' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: /المزيد/ })).toHaveAttribute('href', '/more');
  });

  it('supervisor: الرئيسية · مهامي · التواصل · فريقي · المزيد, with counts as badges', async () => {
    await renderAs(SUP);
    const { bar, labels } = await tabLabels();
    expect(labels.map((l) => l.replace(/\d+/g, ''))).toEqual(['الرئيسية', 'مهامي', 'التواصل', 'فريقي', 'المزيد']);
    // Overdue tasks and unread comments: the accessible name carries the count.
    await waitFor(() => expect(within(bar).getByRole('link', { name: /مهامي — العدد \d+/ })).toBeInTheDocument(), T);
  });

  it('monitor: «تسجيل مخالفة» is the raised centre between مخالفاتي and بانتظار المزامنة', async () => {
    await renderAs(MON);
    const { bar, labels } = await tabLabels();
    expect(labels).toEqual(['الرئيسية', 'مخالفاتي', 'تسجيل مخالفة', 'بانتظار المزامنة', 'المزيد']);
    const record = within(bar).getByRole('link', { name: 'تسجيل مخالفة' });
    expect(record).toHaveClass('primary');
    expect(record).toHaveAttribute('href', '/violations/new');
  });

  it('assistant and participant: home first, «المزيد» last, only pages they may open', async () => {
    for (const who of ['assistant1', 'editor1']) {
      const { api } = await renderAs(who);
      const { labels } = await tabLabels();
      expect(labels[0]).toBe('الرئيسية');
      expect(labels.at(-1)).toMatch(/المزيد/);
      expect(labels.length).toBeGreaterThanOrEqual(2);
      expect(labels.length).toBeLessThanOrEqual(5);
      const me = await api.auth.refresh();
      const tree = visibleNav(me!.user, { teamViolations: false, participant: who === 'editor1' });
      expect(tabsFor(null, tree).every((x) => tree.length > 0 && x.node.path)).toBe(true);
      cleanup();
    }
  }, 30_000);

  it('desktop (1440px) has no bottom bar', async () => {
    emulateWidth(1440);
    await renderAs(ADMIN);
    await screen.findByRole('navigation', { name: 'القائمة الرئيسية' }, T);
    expect(screen.queryByRole('navigation', { name: 'الشريط السفلي' })).toBeNull();
  });
});

describe('A12 «المزيد»', () => {
  it('lists what the bar hides (grouped), the profile, theme, install, version and «البحث عن تحديث», and sign-out', async () => {
    await renderAs(ADMIN, '/more');
    expect(await screen.findByRole('heading', { level: 1, name: 'المزيد' }, T)).toBeInTheDocument();
    expect(screen.getByTestId('more-profile')).toHaveAttribute('href', '/profile');
    // Pages of the bar are not repeated; the rest are, in their groups.
    expect(screen.queryByTestId('more-page-projects')).toBeNull();
    expect(screen.queryByTestId('more-page-communication')).toBeNull();
    expect(screen.getByTestId('more-page-users')).toHaveAttribute('href', '/users');
    expect(screen.getByTestId('more-page-portfolios')).toBeInTheDocument();
    for (const section of ['المظهر', 'التطبيق', 'الحساب', 'الإدارة']) expect(screen.getByRole('region', { name: section })).toBeInTheDocument();
    expect(screen.getByTestId('more-theme')).toBeInTheDocument();
    expect(screen.getByTestId('more-version')).toHaveTextContent(/الإصدار/);
    expect(screen.getByTestId('more-check')).toHaveTextContent('البحث عن تحديث');
    expect(screen.getByTestId('more-logout')).toHaveTextContent('تسجيل الخروج');
    // jsdom is neither iOS nor a browser that offered an install: the manual instructions show.
    expect(screen.getByTestId('more-install-manual')).toHaveAttribute('href', '/install');
  });

  it('the monitor sees no administration in «المزيد»', async () => {
    await renderAs(MON, '/more');
    await screen.findByRole('heading', { level: 1, name: 'المزيد' }, T);
    expect(screen.queryByTestId('more-page-users')).toBeNull();
    expect(screen.queryByTestId('more-page-recordViolation')).toBeNull();
    expect(screen.getByTestId('more-logout')).toBeInTheDocument();
  });
});

describe('A12 phone home — KPI cards per role and the «+»', () => {
  it('admin: four KPI cards, the projects chart, recent projects and the action sheet', async () => {
    await renderAs(ADMIN);
    expect(await screen.findByRole('heading', { level: 1, name: /مرحبًا، / }, T)).toBeInTheDocument();
    for (const id of ['projects', 'active', 'teams', 'requests']) expect(await screen.findByTestId(`kpi-${id}`, {}, T)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('kpi-projects').textContent).toMatch(/\d/), T);
    expect(screen.getByRole('region', { name: 'حالة المشاريع' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'أحدث المشاريع' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fab'));
    const sheet = await screen.findByTestId('fab-actions', {}, T);
    expect(within(sheet).getByRole('link', { name: /مشروع جديد/ })).toHaveAttribute('href', '/projects?create=1');
  });

  it('supervisor: مهامي · متأخرة · أعضاء فريقي · رسائل جديدة', async () => {
    await renderAs(SUP);
    for (const id of ['myTasks', 'overdue', 'team', 'unread']) expect(await screen.findByTestId(`kpi-${id}`, {}, T)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'مهامي حسب الحالة' })).toBeInTheDocument();
  });

  it('monitor: مخالفاتي · بانتظار المزامنة · بلا شخص · أعضاء على الجهاز, and no «+» (the bar records)', async () => {
    await renderAs(MON);
    for (const id of ['myViolations', 'pending', 'unassigned', 'roster']) expect(await screen.findByTestId(`kpi-${id}`, {}, T)).toBeInTheDocument();
    expect(screen.queryByTestId('fab')).toBeNull();
  });
});

describe('A12 sticky form buttons above the keyboard', () => {
  it('keyboardInset reads the covered height from visualViewport (ignores toolbar wobble)', () => {
    expect(keyboardInset({ innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } })).toBe(0);
    expect(keyboardInset({ innerHeight: 844, visualViewport: { height: 800, offsetTop: 0 } })).toBe(0);
    expect(keyboardInset({ innerHeight: 844, visualViewport: { height: 508, offsetTop: 0 } })).toBe(336);
    expect(keyboardInset({ innerHeight: 844, visualViewport: null })).toBe(0);
  });

  it('publishes --kb and data-kb on <html> while the keyboard is open', () => {
    const listeners: Record<string, () => void> = {};
    const vv = { height: 844, offsetTop: 0, addEventListener: (t: string, f: () => void) => (listeners[t] = f), removeEventListener: () => undefined };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(document.documentElement.hasAttribute('data-kb')).toBe(false);
    vv.height = 500;
    act(() => listeners.resize!());
    expect(document.documentElement.style.getPropertyValue('--kb')).toBe('344px');
    expect(document.documentElement.hasAttribute('data-kb')).toBe(true);
    vv.height = 844;
    act(() => listeners.resize!());
    expect(document.documentElement.hasAttribute('data-kb')).toBe(false);
    unmount();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });
});

describe('A12 tablets', () => {
  it('landscape tablets open on the rail unless the user chose; the choice wins', () => {
    useShellStore.setState({ mini: null, autoMini: true });
    expect(selectMini(useShellStore.getState())).toBe(true);
    useShellStore.setState({ mini: false });
    expect(selectMini(useShellStore.getState())).toBe(false);
    useShellStore.setState({ mini: null, autoMini: false });
    expect(selectMini(useShellStore.getState())).toBe(false);
  });

  it('portrait tablets (834px) keep the bottom bar; the side becomes a drawer', async () => {
    emulateWidth(834);
    await renderAs(ADMIN);
    const { labels } = await tabLabels();
    expect(labels).toHaveLength(5);
  });
});
