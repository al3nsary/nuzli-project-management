import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { Drawer, MantineProvider } from '@mantine/core';
import type { Role, UserDto } from '@nuzli/shared';
import { AppProviders } from './App';
import { createTestRouter } from './router';
import { DemoApi } from '../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../api/demo/constants';
import { useAuthStore } from '../stores/auth';
import { ar } from '../i18n/ar';
import { t, type MessageKey } from '../i18n';
import {
  NAV,
  NAV_GROUPS,
  ROUTE_META,
  documentTitle,
  navLeaves,
  resolvePath,
  shortcutTargets,
  trailFor,
  visibleNav,
} from './nav';
import { filterPalette, normalizeAr, paletteItems } from './shell/CommandPalette';
import { foldKey, useShellStore } from './shell/store';
import { useOverlayParam } from '../lib/useUrlState';
import { LoadingBlock } from '../components/ui';

const user = (role: Role, id = `u-${role}`): UserDto =>
  ({
    id,
    fullName: 'نورة بنت سعد العتيبي',
    email: 'x@example.com',
    mobile: '+966500000000',
    nationalIdMasked: '1•••••••23',
    role,
    status: 'ACTIVE',
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { theme: 'auto', digits: 'latn', showHijri: false },
  }) as UserDto;

const ctx = { teamViolations: false };
const ADMIN = user('ADMIN');
const SUPERVISOR = user('SUPERVISOR');
const MONITOR = user('MONITOR');

describe('nav registry → breadcrumbs and titles (rules 1–4)', () => {
  it('uses the deepest match, so /teams/formation is not «كل الفرق»', () => {
    expect(resolvePath('/teams/formation').leaf?.id).toBe('formation');
    expect(resolvePath('/teams').leaf?.id).toBe('teams');
    expect(resolvePath('/cards/templates').leaf?.id).toBe('cardTemplates');
    expect(resolvePath('/').leaf?.id).toBe('dashboard');
    // A detail page keeps its list item active.
    const team = resolvePath('/teams/abc');
    expect(team.meta?.entity).toBe('team');
    expect(team.leaf?.id).toBe('teams');
    expect(team.params.id).toBe('abc');
  });

  it('has no breadcrumbs on top-level pages and a parent trail below them', () => {
    const top = trailFor('/teams', { user: ADMIN, ctx, translate: t });
    expect(top.title).toBe('الفرق');
    expect(top.crumbs).toEqual([]);
    expect(top.group).toBe('الفرق والكروت');

    const formation = trailFor('/teams/formation', { user: ADMIN, ctx, translate: t });
    expect(formation.title).toBe('تشكيل الفرق');
    expect(formation.crumbs).toEqual([{ label: 'الفرق', to: '/teams' }]);
    expect(formation.parent).toBe('/teams');

    const calendars = trailFor('/settings/calendars', { user: ADMIN, ctx, translate: t });
    expect(calendars.crumbs.map((c) => c.label)).toEqual(['إعدادات النظام']);
  });

  it('names detail pages after their entity, with the drawer item as the last crumb', () => {
    const team = trailFor('/teams/abc', { user: SUPERVISOR, ctx, translate: t, entityName: 'فريق الصقور' });
    expect(team.title).toBe('فريق الصقور');
    expect(team.crumbs).toEqual([{ label: 'الفرق', to: '/teams' }]);
    expect(team.parent).toBe('/teams');

    const task = trailFor('/projects/p1', { user: ADMIN, ctx, translate: t, entityName: 'تأهيل الحديقة', extra: 'تسوير الموقع' });
    expect(task.title).toBe('تسوير الموقع');
    expect(task.crumbs.map((c) => c.label)).toEqual(['المشاريع', 'تأهيل الحديقة']);
  });

  it('does not show a monitor a parent page they cannot open', () => {
    const record = trailFor('/violations/new', { user: MONITOR, ctx, translate: t });
    expect(record.crumbs).toEqual([]);
    const admin = trailFor('/violations/new', { user: ADMIN, ctx, translate: t });
    expect(admin.crumbs.map((c) => c.label)).toEqual(['المخالفات']);
  });

  it('marks forbidden and unknown paths', () => {
    expect(trailFor('/users', { user: MONITOR, ctx, translate: t }).status).toBe('forbidden');
    expect(trailFor('/nowhere', { user: ADMIN, ctx, translate: t }).status).toBe('missing');
  });

  it('builds «{الصفحة} · نُزلي» document titles', () => {
    expect(documentTitle('الفرق', t('app.name'))).toBe('الفرق · نُزلي');
  });

  it('renders only what the role may use (rule 12) and collapses single-child groups', () => {
    const ids = (u: UserDto) => navLeaves(visibleNav(u, ctx)).map((n) => n.id);
    expect(ids(MONITOR)).toEqual(['dashboard', 'notifications', 'recordViolation', 'myViolations', 'pendingSync']);
    expect(ids(SUPERVISOR)).toContain('myTasks');
    expect(ids(SUPERVISOR)).not.toContain('formation');
    // A9: admins have «مهامي» too (GanttPRO order); supervisors no longer see projects.
    expect(ids(ADMIN)).toContain('myTasks');
    expect(ids(SUPERVISOR)).not.toContain('teamViolations');
    expect(navLeaves(visibleNav(SUPERVISOR, { teamViolations: true })).map((n) => n.id)).toContain('teamViolations');
    // Supervisors see two «الفرق» pages, so the container stays; admins see all kids.
    const adminTeams = visibleNav(ADMIN, ctx).find((n) => n.id === 'teamsGroup');
    expect(adminTeams?.children?.map((c) => c.id)).toEqual(['teams', 'formation', 'members']);
  });

  it('orders the admin navigation like GanttPRO (A9)', () => {
    const top = visibleNav(ADMIN, ctx);
    const ids = navLeaves(top).map((n) => n.id);
    const order = ['dashboard', 'projects', 'portfolios', 'myTasks', 'timeLog', 'reports', 'workload', 'communication', 'attachments', 'notifications'];
    expect(ids.slice(0, order.length)).toEqual(order);
    // Then the field operations, then administration.
    const after = ids.slice(order.length);
    expect(after.indexOf('teams')).toBeLessThan(after.indexOf('formation'));
    expect(after.indexOf('formation')).toBeLessThan(after.indexOf('orgStructure'));
    expect(after.indexOf('orgStructure')).toBeLessThan(after.indexOf('violations'));
    expect(after.indexOf('violations')).toBeLessThan(after.indexOf('users'));
    expect(top.map((n) => n.group)).toEqual([...top.map((n) => n.group)].sort((a, b) => NAV_GROUPS.findIndex((g) => g.id === a) - NAV_GROUPS.findIndex((g) => g.id === b)));
    // The side label is «كل المشاريع», the page title stays «المشاريع».
    const projects = top.find((n) => n.id === 'projects')!;
    expect(t(projects.label)).toBe('كل المشاريع');
    expect(trailFor('/projects', { user: ADMIN, ctx, translate: t }).title).toBe('المشاريع');
    // A9 pages built in the A9 rounds are real pages now (none is «قيد الإنشاء» any more).
    for (const id of ['portfolios', 'timeLog', 'reports', 'workload', 'communication', 'attachments', 'orgStructure']) {
      const leaf = navLeaves().find((n) => n.id === id)!;
      expect(leaf.soon, id).toBeUndefined();
      expect(leaf.permission ?? leaf.anyOf, id).toBeTruthy();
      expect(trailFor(leaf.path!, { user: ADMIN, ctx, translate: t }).status ?? 'ok', id).toBe('ok');
    }
    expect(navLeaves().find((n) => n.id === 'communication')!.path).toBe('/hub');
    expect(navLeaves().find((n) => n.id === 'orgStructure')!.path).toBe('/org');
  });

  it('shows supervisors «مهامي» first and no project management (A9)', () => {
    for (const c of [ctx, { teamViolations: true }]) {
      const top = visibleNav(SUPERVISOR, c);
      const ids = navLeaves(top).map((n) => n.id);
      expect(ids[0]).toBe('myTasks');
      expect(top[0]!.group).toBe('home');
      for (const forbidden of ['projects', 'portfolios', 'reports', 'workload']) {
        expect(ids, forbidden).not.toContain(forbidden);
      }
      // A9: the hub and the attachments browser are scoped to their own tasks; the org chart is read-only.
      for (const allowedId of ['communication', 'attachments', 'orgStructure']) expect(ids, allowedId).toContain(allowedId);
      // No route into project management from the palette or the shortcuts either.
      const palette = paletteItems(SUPERVISOR, top, []);
      expect(palette.some((i) => i.to === '/projects' || i.to === '/portfolios' || i.to === '/reports' || i.to === '/workload')).toBe(false);
      expect(shortcutTargets(top).get('p')).toBeUndefined();
    }
    expect(trailFor('/projects', { user: SUPERVISOR, ctx, translate: t }).status).toBe('forbidden');
    expect(trailFor('/my-tasks', { user: SUPERVISOR, ctx, translate: t }).group).toBe('الرئيسية');
  });

  it('maps `g` shortcuts to the first visible page for each key', () => {
    const admin = shortcutTargets(visibleNav(ADMIN, ctx));
    expect(admin.get('p')?.path).toBe('/projects');
    expect(admin.get('t')?.path).toBe('/teams');
    expect(admin.get('v')?.path).toBe('/violations');
    const sup = shortcutTargets(visibleNav(SUPERVISOR, { teamViolations: true }));
    expect(sup.get('v')?.path).toBe('/violations/team');
    expect(shortcutTargets(visibleNav(MONITOR, ctx)).get('p')).toBeUndefined();
  });
});

describe('i18n keys used by navigation are complete', () => {
  it('has a non-empty Arabic label for every registry entry, group and route', () => {
    const keys: string[] = [];
    const walk = (nodes: typeof NAV) => {
      for (const n of nodes) {
        keys.push(n.label, ...(n.title ? [n.title] : []));
        if (n.children) walk(n.children);
      }
    };
    walk(NAV);
    keys.push(...NAV_GROUPS.map((g) => g.label), ...ROUTE_META.map((m) => m.title));
    for (const k of keys) {
      expect((ar as Record<string, string>)[k], k).toBeTruthy();
      expect((ar as Record<string, string>)[k], k).not.toMatch(/[A-Za-z]/);
    }
    for (const k of ['palette.title', 'palette.placeholder', 'shortcuts.title', 'nav.breadcrumbs', 'brand.developedBy', 'brand.system'] as MessageKey[]) {
      expect(t(k)).toBeTruthy();
    }
  });
});

describe('command palette (rule 7)', () => {
  it('lists only pages and actions the user may use', () => {
    const monitor = paletteItems(MONITOR, visibleNav(MONITOR, ctx), []);
    const labels = monitor.map((i) => i.label);
    expect(labels).toContain('تسجيل مخالفة');
    expect(labels).not.toContain('المستخدمون');
    expect(labels).not.toContain('إنشاء فريق');
    expect(labels).not.toContain('مشروع جديد');
    expect(monitor.every((i) => !i.to || !i.to.startsWith('/users'))).toBe(true);

    const admin = paletteItems(ADMIN, visibleNav(ADMIN, ctx), []).map((i) => i.label);
    expect(admin).toEqual(expect.arrayContaining(['المستخدمون', 'إنشاء فريق', 'مشروع جديد', 'تشكيل الفرق']));
  });

  it('drops recent items the user can no longer open and shows shortcut hints', () => {
    const items = paletteItems(MONITOR, visibleNav(MONITOR, ctx), [{ kind: 'team', id: 't1', name: 'فريق الصقور', path: '/teams/t1' }]);
    expect(items.find((i) => i.section === 'recent')).toBeUndefined();
    const sup = paletteItems(SUPERVISOR, visibleNav(SUPERVISOR, ctx), [{ kind: 'team', id: 't1', name: 'فريق الصقور', path: '/teams/t1' }]);
    expect(sup[0]).toMatchObject({ section: 'recent', label: 'فريق الصقور', to: '/teams/t1' });
    expect(paletteItems(ADMIN, visibleNav(ADMIN, ctx), []).find((i) => i.to === '/projects')?.hint).toBe('G P');
  });

  it('matches Arabic loosely (alef forms, ta marbuta, diacritics)', () => {
    expect(normalizeAr('إعدادات النِّظام')).toBe(normalizeAr('اعدادات النظام'));
    const items = paletteItems(ADMIN, visibleNav(ADMIN, ctx), []);
    expect(filterPalette(items, 'اعدادات').map((i) => i.label)).toContain('إعدادات النظام');
    expect(filterPalette(items, 'تشكيل').map((i) => i.to)).toEqual(['/teams/formation']);
  });
});

async function renderApp(identifier: string, path = '/') {
  const api = new DemoApi({ dbName: `nuzli-nav-${Math.random()}` });
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  const view = render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { api, router, view };
}

describe('shell behaviour', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useShellStore.setState({ userId: null, mini: false, drawer: false, palette: false, sheet: false, recent: [] });
  });

  it('folds the side with Ctrl+B and remembers it for the user', async () => {
    const { view } = await renderApp('admin1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    expect(nav).not.toHaveClass('mini');
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    await waitFor(() => expect(nav).toHaveClass('mini'));
    const id = useAuthStore.getState().user!.id;
    expect(window.localStorage.getItem(foldKey(id))).toBe('1');

    // A new session for the same user starts folded.
    view.unmount();
    useShellStore.setState({ userId: null, mini: false });
    await renderApp('admin1@demo.nuzli.example');
    const again = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    await waitFor(() => expect(again).toHaveClass('mini'));
  });

  it('ignores shortcuts while typing in a field', async () => {
    await renderApp('admin1@demo.nuzli.example');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(nav).not.toHaveClass('mini');
    input.remove();
  });

  it('opens the palette with Ctrl+K and hides pages the user cannot open', async () => {
    await renderApp('monitor1@demo.nuzli.example');
    await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const list = await screen.findByRole('listbox', { name: 'النتائج' });
    expect(within(list).getAllByText('تسجيل مخالفة').length).toBeGreaterThan(0);
    expect(within(list).queryByText('المستخدمون')).toBeNull();
  });

  it('marks the active item with aria-current and expands its parent', async () => {
    await renderApp('admin1@demo.nuzli.example', '/teams/formation');
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    const link = within(nav).getByRole('link', { name: 'تشكيل الفرق' });
    expect(link).toHaveAttribute('aria-current', 'page');
    const parent = within(nav).getByRole('button', { name: /الفرق/ });
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(document.title).toBe('تشكيل الفرق · نُزلي'));
    expect(screen.getByRole('navigation', { name: 'مسار الصفحة' })).toHaveTextContent('الفرق');
  });
});

function DrawerPage() {
  const drawer = useOverlayParam('member');
  return (
    <>
      <button type="button" onClick={() => drawer.open('m1')}>
        فتح
      </button>
      <Drawer opened={drawer.value === 'm1'} onClose={drawer.close} title="درج العضو">
        <p>محتوى الدرج</p>
      </Drawer>
    </>
  );
}

describe('URL-driven drawers (rule 5)', () => {
  const renderDrawer = (path: string) => {
    const router = createMemoryRouter([{ path: '/members', element: <DrawerPage /> }], { initialEntries: ['/start', path] , initialIndex: 1 });
    render(
      <AppProviders api={new DemoApi({ dbName: `nuzli-drawer-${Math.random()}` })}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    return router;
  };

  it('opens with a history entry, and the browser back button closes it', async () => {
    const router = renderDrawer('/members');
    fireEvent.click(await screen.findByRole('button', { name: 'فتح' }));
    await screen.findByText('محتوى الدرج');
    expect(router.state.location.search).toBe('?member=m1');
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/members');
    expect(router.state.location.search).toBe('');
    await waitFor(() => expect(screen.queryByText('محتوى الدرج')).toBeNull());
  });

  it('opens from a deep link and closes in place without leaving the page', async () => {
    const router = renderDrawer('/members?member=m1');
    await screen.findByText('محتوى الدرج');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe('/members');
  });
});

describe('loading states (rule 9)', () => {
  it('renders a layout-shaped skeleton, not a spinner', () => {
    const { container } = render(<MantineProvider><LoadingBlock variant="table" header /></MantineProvider>);
    const box = container.querySelector('[aria-busy="true"]');
    expect(box).not.toBeNull();
    expect(container.querySelectorAll('.nz-skel').length).toBeGreaterThan(10);
    expect(container.querySelector('.mantine-Loader-root')).toBeNull();
  });

  it('shows the page skeleton while the data is on its way', async () => {
    const { api } = await renderApp('admin1@demo.nuzli.example', '/projects');
    // Hold the project list: the page must show its skeleton meanwhile.
    api.projects.list = () => new Promise(() => undefined);
    await screen.findByRole('heading', { name: 'كل المشاريع', level: 1 }, { timeout: 5000 });
    await waitFor(() => expect(document.querySelector('#main .nz-skel-wrap')).not.toBeNull());
    expect(document.querySelector('#main .mantine-Loader-root')).toBeNull();
  });
});
