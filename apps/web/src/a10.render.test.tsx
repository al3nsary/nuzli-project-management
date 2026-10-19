/**
 * Owner request A10 on the DemoApi: light by default (even when the device is dark, and for a
 * stored `auto`), the demo-data upgrade, the project manager's chat icon (count, unread, the same
 * task screen as the supervisor, deep link, admin ⇄ supervisor messages) and the worker foreman
 * everywhere (team detail, formation board, roster, member drawer, work card).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterProvider } from 'react-router-dom';
import { WorkCard } from '@nuzli/ui-print';
import { AppProviders } from './app/App';
import { createTestRouter } from './app/router';
import { DemoApi, DEMO_DATA_VERSION } from './api/demo/DemoApi';
import { DEMO_PASSWORD } from './api/demo/constants';
import { useAuthStore } from './stores/auth';
import {
  SCHEME_STORAGE_KEY,
  THEME_MIGRATION_KEY,
  THEME_MIGRATION_VERSION,
  effectiveScheme,
  migrateStoredColorScheme,
  nzColorSchemeManager,
} from './theme/colorScheme';
import { TaskChatButton } from './features/tasks/TaskChatButton';
import { withForemanRole } from './pages/cards/cardUtils';
import { MantineProvider } from '@mantine/core';
import { OfflineDb } from './features/violations/offline/db';
import { refreshRoster } from './features/violations/offline/roster';

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const TEAM1 = '00000000-0000-4000-8000-a00000000001';
const T = { timeout: 10_000 };

async function renderAs(identifier: string, path: string, api = new DemoApi({ dbName: `nuzli-a10-${Math.random()}` })) {
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

// ---------------------------------------------------------------- 1. light by default

describe('light by default (A10, ADR-127)', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    localStorage.clear();
    // The device is in dark mode.
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
    localStorage.clear();
    document.documentElement.removeAttribute('data-mantine-color-scheme');
  });

  it('renders light on a dark device, with nothing stored', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-light-${Math.random()}` });
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
    render(
      <AppProviders api={api}>
        <RouterProvider router={createTestRouter('/login')} />
      </AppProviders>,
    );
    await waitFor(() => expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light'));
  });

  it('a stored `auto` (the old default) migrates to light once; an explicit dark stays dark', () => {
    localStorage.setItem(SCHEME_STORAGE_KEY, 'auto');
    migrateStoredColorScheme();
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(THEME_MIGRATION_KEY)).toBe(THEME_MIGRATION_VERSION);
    // Once: a later explicit choice is not touched.
    localStorage.setItem(SCHEME_STORAGE_KEY, 'dark');
    migrateStoredColorScheme();
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('dark');
    localStorage.clear();
    localStorage.setItem(SCHEME_STORAGE_KEY, 'dark');
    migrateStoredColorScheme();
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('dark');
  });

  it('the scheme manager and the preference map never follow the OS', () => {
    const m = nzColorSchemeManager();
    localStorage.setItem(SCHEME_STORAGE_KEY, 'auto');
    expect(m.get('auto')).toBe('light');
    m.set('auto');
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('light');
    m.set('dark');
    expect(m.get('light')).toBe('dark');
    expect(effectiveScheme('auto')).toBe('light');
    expect(effectiveScheme(undefined)).toBe('light');
    expect(effectiveScheme('dark')).toBe('dark');
  });

  it('a signed-in user whose preference is `auto` gets light; «داكن» gives dark', async () => {
    const { api } = await renderAs(ADMIN, '/');
    await screen.findByRole('heading', { level: 1 }, T);
    await waitFor(() => expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light'));
    const user = await api.me.update({ preferences: { theme: 'dark' } });
    useAuthStore.getState().setUser(user);
    await waitFor(() => expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark'));
  }, 30_000);

  it('tokens.css has no prefers-color-scheme block; index.html declares light only', () => {
    const root = join(__dirname, '..');
    const tokens = readFileSync(join(root, 'src/theme/tokens.css'), 'utf8');
    expect(tokens).not.toMatch(/@media\s*\(prefers-color-scheme/);
    expect(tokens).toContain(":root[data-mantine-color-scheme='dark']");
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(html).toContain('data-mantine-color-scheme="light"');
  });
});

// ---------------------------------------------------------------- 2. demo data upgrade

describe('demo data upgrade (A10, ADR-128)', () => {
  it('a fresh browser is seeded at the bundled version with no notice', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-fresh-${Math.random()}` });
    await api.auth.refresh();
    expect(await api.storedDataVersion()).toBe(DEMO_DATA_VERSION);
    expect(api.demo.consumeUpgradeNotice?.()).toBe(false);
  });

  it('old demo data (older version, or none) is replaced by the new seed once, with a notice', async () => {
    const dbName = `nuzli-a10-old-${Math.random()}`;
    const old = new DemoApi({ dbName });
    await old.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    // Simulate a browser seeded before A10: no version, no foremen, a stray edit.
    await old.db.kv.delete('demoDataVersion');
    await old.db.memberships.toCollection().modify((m) => {
      delete m.role;
    });
    await old.db.teams.update(TEAM1, { name: 'اسم قديم' });
    old.db.close();

    const fresh = new DemoApi({ dbName });
    expect(await fresh.auth.refresh()).toBeNull(); // the old session went with the old data
    expect(fresh.demo.consumeUpgradeNotice?.()).toBe(true);
    expect(fresh.demo.consumeUpgradeNotice?.()).toBe(false);
    expect(await fresh.storedDataVersion()).toBe(DEMO_DATA_VERSION);
    const session = await fresh.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    fresh.setAccessToken(session.accessToken);
    const teams = await fresh.teams.list({ status: 'ACTIVE' });
    expect(teams.find((x) => x.id === TEAM1)?.name).not.toBe('اسم قديم');
    // Every active team has its foreman; several supervisors and the org structure are back.
    for (const tm of teams) expect((tm as typeof tm & { foreman?: unknown }).foreman, tm.name).toBeTruthy();
    expect(teams.some((tm) => (tm.supervisors?.length ?? 0) > 1)).toBe(true);
    expect((await fresh.org.tree()).units.length).toBeGreaterThan(0);
  }, 30_000);

  it('the shell shows «حُدِّثت بيانات العرض إلى أحدث إصدار» after an upgrade', async () => {
    const dbName = `nuzli-a10-toast-${Math.random()}`;
    const old = new DemoApi({ dbName });
    await old.auth.refresh();
    await old.db.kv.put({ key: 'demoDataVersion', value: 1 });
    old.db.close();
    const api = new DemoApi({ dbName });
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
    render(
      <AppProviders api={api}>
        <RouterProvider router={createTestRouter('/login')} />
      </AppProviders>,
    );
    expect(await screen.findByText('حُدِّثت بيانات العرض إلى أحدث إصدار', {}, T)).toBeInTheDocument();
  }, 30_000);
});

// ---------------------------------------------------------------- 3. project-manager chat

async function supervisorTask(api: DemoApi) {
  const sup = (await api.users.list({ role: 'SUPERVISOR', pageSize: 100 })).items.find((u) => u.email === SUP1)!;
  for (const p of await api.projects.list()) {
    const g = await api.projects.gantt(p.id);
    const task = g.tasks.find((x) => x.assignee?.id === sup.id && x.type === 'TASK');
    if (task) return { project: p, task, sup };
  }
  throw new Error('no task for supervisor1');
}

describe('project-manager chat from inside projects (A10)', () => {
  it('the chat icon shows the count and the unread badge; clicking opens without opening the row', () => {
    const onOpen = vi.fn();
    render(
      <MantineProvider>
        <div onClick={() => onOpen('row')}>
          <TaskChatButton taskName="صب الخرسانة" chat={{ count: 4, unread: 2 }} onOpen={() => onOpen('chat')} />
        </div>
      </MantineProvider>,
    );
    const btn = screen.getByRole('button', { name: 'محادثة المهمة «صب الخرسانة»: 4 رسالة، 2 غير مقروءة' });
    expect(btn).toHaveAttribute('data-unread', 'true');
    expect(within(btn).getByText('4')).toBeInTheDocument();
    expect(within(btn).getByText('2')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onOpen.mock.calls).toEqual([['chat']]);
  });

  it('DemoApi: gantt tasks carry commentCount and the viewer\'s unreadCount', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-counts-${Math.random()}` });
    const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const hub = (await api.hub.list({ filter: 'all', pageSize: 100 })).items;
    const item = hub.find((i) => i.unreadCount > 0) ?? hub[0]!;
    const g = await api.projects.gantt(item.project.id);
    const task = g.tasks.find((x) => x.id === item.task.id) as (typeof g.tasks)[number] & { unreadCount?: number };
    expect(task.commentCount).toBe(item.commentCount);
    expect(task.unreadCount).toBe(item.unreadCount);
  }, 30_000);

  it('admin → supervisor: the message reaches «مهامي» and the hub; the reply comes back unread', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-msg-${Math.random()}` });
    let s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const { project, task } = await supervisorTask(api);
    await api.tasks.markRead(task.id);
    await api.tasks.addComment(task.id, { body: 'رجاءً أرسل صور الموقع اليوم', mentions: [] });

    s = await api.auth.login({ identifier: SUP1, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const mine = (await api.tasks.mine()).find((x) => x.id === task.id) as { unreadCount?: number } | undefined;
    expect(mine?.unreadCount).toBeGreaterThan(0);
    expect((await api.tasks.comments(task.id)).some((c) => c.body === 'رجاءً أرسل صور الموقع اليوم')).toBe(true);
    expect((await api.hub.list({ filter: 'new' })).items.some((i) => i.task.id === task.id)).toBe(true);
    const notes = await api.notifications.list({});
    expect(notes.items.some((n) => n.type === 'TASK_COMMENTED' && (n.payload as { taskId?: string }).taskId === task.id)).toBe(true);
    await api.tasks.addComment(task.id, { body: 'تم، أرسلتها', mentions: [] });

    s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const g = await api.projects.gantt(project.id);
    const back = g.tasks.find((x) => x.id === task.id) as (typeof g.tasks)[number] & { unreadCount?: number };
    expect(back.unreadCount).toBe(1);
  }, 30_000);

  it('the grid has «المحادثة» by default; its icon opens the supervisor\'s screen over the project (?chat=), Esc closes', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-grid-${Math.random()}` });
    const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const { project, task } = await supervisorTask(api);
    const { router } = await renderAs(ADMIN, `/projects/${project.id}?view=list`, api);
    expect(await screen.findByRole('columnheader', { name: /المحادثة/ }, { timeout: 20_000 })).toBeInTheDocument();
    const icon = await screen.findByRole('button', { name: new RegExp(`(محادثة المهمة|ابدأ محادثة المهمة) «${task.name}»`) }, T);
    fireEvent.click(icon);
    await waitFor(() => expect(router.state.location.search).toContain(`chat=${task.id}`));
    const dialog = await screen.findByRole('dialog', {}, T);
    expect(await within(dialog).findByRole('heading', { level: 2, name: task.name }, T)).toBeInTheDocument();
    // The same screen as «مهامي»: the chat thread, its composer, and the task details.
    expect(await within(dialog).findByRole('log', {}, T)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'إغلاق المحادثة' })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).not.toContain('chat='), T);
  }, 60_000);

  it('a deep link ?chat=<taskId> opens the task screen directly', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-deep-${Math.random()}` });
    const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const { project, task } = await supervisorTask(api);
    await renderAs(ADMIN, `/projects/${project.id}?chat=${task.id}`, api);
    const dialog = await screen.findByRole('dialog', {}, { timeout: 20_000 });
    expect(await within(dialog).findByRole('heading', { level: 2, name: task.name }, T)).toBeInTheDocument();
  }, 60_000);
});

// ---------------------------------------------------------------- 4. the worker foreman everywhere

describe('the worker foreman everywhere (A10)', () => {
  it('team detail: the foreman first under «مشرف العمّال», then «العمّال», with the helmet avatar and badge', async () => {
    await renderAs(ADMIN, `/teams/${TEAM1}`);
    const sep = await screen.findByText('مشرف العمّال', {}, T);
    const sepRow = sep.closest('tr')!;
    const foremanRow = sepRow.nextElementSibling as HTMLElement;
    expect(foremanRow).toHaveAttribute('data-foreman', 'true');
    expect(within(foremanRow).getByRole('img', { name: 'مشرف عمّال' })).toBeInTheDocument();
    expect(within(foremanRow).getByLabelText('مشرف عمّال — لا يملك حسابًا ولا صلاحيات')).toBeInTheDocument();
    expect((foremanRow.nextElementSibling as HTMLElement).textContent).toMatch(/^العمّال \(\d+\)$/);
    // The header names the foreman under the supervisors, and every worker row offers the action.
    expect(screen.getAllByText('مشرف عمّال:').length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: /^تعيين .* مشرف عمّال$/ }, T)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('تعيين مشرفًا للعمّال').length).toBeGreaterThan(0);
  }, 30_000);

  it('teams list: every active team card names its foreman', async () => {
    await renderAs(ADMIN, '/teams?status=ACTIVE');
    await screen.findByRole('heading', { level: 1, name: 'الفرق' }, T);
    await waitFor(() => expect(screen.getAllByText('مشرف عمّال:').length).toBe(5), T);
  }, 30_000);

  it('formation board: the foreman card is pinned at the top of its team column', async () => {
    await renderAs(ADMIN, '/teams/formation');
    const col = (await screen.findAllByRole('region', {}, { timeout: 15_000 })).find((r) => r.getAttribute('data-col') === TEAM1)
      ?? (document.querySelector(`[data-col="${TEAM1}"]`) as HTMLElement);
    await waitFor(() => expect(col.querySelectorAll('.nz-member-card').length).toBeGreaterThan(1), T);
    const first = col.querySelector('.nz-member-card') as HTMLElement;
    expect(first).toHaveAttribute('data-foreman', 'true');
    expect(within(col).getByText(/^مشرف عمّال: /)).toBeInTheDocument();
  }, 30_000);

  it('member drawer and members list show the badge', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-md-${Math.random()}` });
    const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const team = await api.teams.get(TEAM1);
    const foreman = team.members.find((m) => m.isForeman)!;
    await renderAs(ADMIN, `/members?member=${foreman.id}`, api);
    const dialog = await screen.findByRole('dialog', {}, { timeout: 15_000 });
    expect(await within(dialog).findByLabelText('مشرف عمّال — لا يملك حسابًا ولا صلاحيات', {}, T)).toBeInTheDocument();
  }, 30_000);

  it('roster: the device roster marks the foreman', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-roster-${Math.random()}` });
    const s = await api.auth.login({ identifier: 'monitor1@demo.nuzli.example', password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const roster = await api.violations.roster();
    const flagged = roster.items.filter((r) => (r as typeof r & { isForeman?: boolean }).isForeman);
    expect(flagged.length).toBe(5);
    // The copy cached on the device keeps the flag (QA found it dropped).
    const db = new OfflineDb(`nuzli-a10-offline-${Math.random()}`);
    await refreshRoster(api, db, s.user.id);
    expect((await db.roster.toArray()).filter((r) => (r as typeof r & { isForeman?: boolean }).isForeman)).toHaveLength(5);
  }, 30_000);

  it('work card: the preview data of the foreman prints the «مشرف عمّال» ribbon in every layout', async () => {
    const api = new DemoApi({ dbName: `nuzli-a10-card-${Math.random()}` });
    const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const templates = await api.cards.templates();
    const sizes = await api.cards.sizes();
    const res = await api.cards.preview({ templateId: templates[0]!.id, teamIds: [TEAM1], includeSupervisors: false });
    const fm = res.subjects.find((x) => (x.data as { isForeman?: boolean }).isForeman)!;
    expect(fm.data.roleLabel).toBe('مشرف عمّال');
    for (const layoutKey of ['CLASSIC_HORIZONTAL', 'VERTICAL_BADGE', 'COMPACT_LABEL'] as const) {
      for (const size of sizes.filter((z) => (z.widthMm === 85.6 && z.heightMm === 54) || (z.widthMm === 90 && z.heightMm === 40))) {
        const html = renderToStaticMarkup(
          <WorkCard template={{ size, orientation: 'LANDSCAPE', layoutKey, config: templates[0]!.config }} data={fm.data} />,
        );
        expect(html).toContain('data-foreman="true"');
        expect(html).toContain('مشرف عمّال');
        expect(html).not.toMatch(/\dpx\b/);
      }
    }
    // A worker who is not the foreman prints no ribbon.
    const worker = res.subjects.find((x) => !(x.data as { isForeman?: boolean }).isForeman)!;
    expect(renderToStaticMarkup(<WorkCard template={{ size: sizes[0]!, orientation: 'LANDSCAPE', layoutKey: 'CLASSIC_HORIZONTAL' }} data={worker.data} />)).not.toContain('data-foreman');
  }, 30_000);

  it('cards: data without the flag is marked from MemberDto.isForeman (HttpApi fallback)', () => {
    const d = { fullName: 'س' };
    expect(withForemanRole(d, false)).toBe(d);
    expect(withForemanRole(d, true)).toEqual({ fullName: 'س', isForeman: true, roleLabel: 'مشرف عمّال' });
    expect(withForemanRole({ fullName: 'س', roleLabel: 'مشرف عمّال' }, false)).toMatchObject({ isForeman: true });
  });
});
