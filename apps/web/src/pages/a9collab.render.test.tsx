/**
 * A9 collaboration/teams/org/violations screens on the DemoApi (owner request A9): the
 * communication hub (tabs, unread, opening a chat marks it read, deep link), the attachments
 * browser (grid/list, type filter, supervisor scope), team detail with several supervisors and the
 * worker foreman (admin vs co-supervisor actions), the org structure (tree, chart, read-only for
 * supervisors), and the OCR panel → suggestion → assignment on an unassigned violation.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { useViolation } from '../api/queries';
import { AssignSection } from './violations/assign';
import { AppProviders } from '../app/App';
import { createTestRouter } from '../app/router';
import { DemoApi } from '../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../api/demo/constants';
import { useAuthStore } from '../stores/auth';

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP3 = 'supervisor3@demo.nuzli.example';
const TEAM1 = '00000000-0000-4000-8000-a00000000001';
const UNASSIGNED_1 = '00000000-0000-4000-8000-d90000000001';
const T = { timeout: 10_000 };

async function renderAs(identifier: string, path: string, setup?: (api: DemoApi) => void | Promise<void>) {
  const api = new DemoApi({ dbName: `nuzli-a9c-${Math.random()}` });
  await setup?.(api);
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

describe('communication hub /hub', () => {
  it('lists threads with project, parent path and unread; the «new» tab filters; opening a chat marks it read', async () => {
    const { api, router } = await renderAs(SUP1, '/hub');
    expect(await screen.findByRole('heading', { level: 1, name: 'مركز التواصل' }, T)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'المهام ذات المحادثات' }, T);
    const rows = within(list).getAllByRole('button');
    expect(rows.length).toBeGreaterThan(0);
    // Every tab of screenshot 3, with counts.
    for (const name of ['كل المهام', 'بها تعليقات جديدة', 'أُشير إليّ', 'مُسندة إليّ', 'أنشأتُها']) {
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole('textbox', { name: 'ابحث باسم المهمة أو التعليق' })).toBeInTheDocument();
    await api.auth.login({ identifier: SUP1, password: DEMO_PASSWORD });
    const unread = (await api.hub.list({ filter: 'new' })).items;
    fireEvent.click(screen.getByRole('tab', { name: /بها تعليقات جديدة/ }));
    await waitFor(() => expect(router.state.location.search).toContain('filter=new'));
    const newList = await screen.findByRole('list', { name: 'المهام ذات المحادثات' }, T);
    await waitFor(() => expect(within(newList).getAllByRole('button')).toHaveLength(unread.length));
    if (!unread.length) return;
    const first = unread[0]!;
    fireEvent.click(within(newList).getByRole('button', { name: new RegExp(first.task.name) }));
    // Phones (jsdom) open the chat full-screen; the URL carries ?task=.
    expect(await screen.findByRole('log', {}, T)).toBeInTheDocument();
    expect(router.state.location.search).toContain(`task=${first.task.id}`);
    await waitFor(async () => expect((await api.hub.list({ filter: 'new' })).items.some((i) => i.task.id === first.task.id)).toBe(false), T);
  }, 40_000);

  it('a deep link ?task= opens that chat directly', async () => {
    const api0 = new DemoApi({ dbName: `nuzli-a9c-peek-${Math.random()}` });
    await api0.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    const item = (await api0.hub.list({ filter: 'all' })).items[0]!;
    await renderAs(ADMIN, `/hub?task=${item.task.id}`);
    expect(await screen.findByRole('region', { name: `محادثة المهمة ${item.task.name}` }, T)).toBeInTheDocument();
    expect(await screen.findByRole('log', {}, T)).toBeInTheDocument();
  }, 30_000);
});

describe('attachments /attachments', () => {
  it('shows a grid, switches to a list with columns, and filters by type', async () => {
    const { router } = await renderAs(ADMIN, '/attachments');
    expect(await screen.findByRole('heading', { level: 1, name: 'المرفقات' }, T)).toBeInTheDocument();
    const grid = await screen.findByRole('list', { name: 'المرفقات' }, T);
    expect(within(grid).getAllByRole('listitem').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('قائمة'));
    expect(await screen.findByRole('columnheader', { name: 'المهمة' }, T)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'PDF' }));
    await waitFor(() => expect(router.state.location.search).toContain('type=pdf'));
  }, 30_000);
});

describe('team detail with several supervisors and the foreman', () => {
  it('admin: both supervisors with «رئيسي», the add action, one foreman badge with its tooltip text', async () => {
    await renderAs(ADMIN, `/teams/${TEAM1}`);
    const card = await screen.findByRole('heading', { name: 'مشرفو الفريق' }, T);
    const section = card.closest('.mantine-Card-root') as HTMLElement;
    expect(within(section).getByText('فهد بن خالد الدوسري')).toBeInTheDocument();
    expect(within(section).getByText('ماجد بن علي الغامدي')).toBeInTheDocument();
    expect(within(section).getAllByText('رئيسي')).toHaveLength(1);
    expect(within(section).getByRole('button', { name: 'إضافة مشرف' })).toBeInTheDocument();
    const badges = await screen.findAllByLabelText('مشرف عمّال — لا يملك حسابًا ولا صلاحيات', {}, T);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest('tr')).toHaveClass('nz-foreman-row');
  }, 30_000);

  it('co-supervisor: reads both supervisors, cannot add or remove them, may set the foreman', async () => {
    await renderAs(SUP3, `/teams/${TEAM1}`);
    const card = await screen.findByRole('heading', { name: 'مشرفو الفريق' }, T);
    const section = card.closest('.mantine-Card-root') as HTMLElement;
    expect(within(section).getByText('ماجد بن علي الغامدي')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'إضافة مشرف' })).toBeNull();
    expect(within(section).queryByRole('button', { name: /إجراءات/ })).toBeNull();
    expect((await screen.findAllByRole('button', { name: /^تعيين .* مشرف عمّال$/ }, T)).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('organisational structure /org', () => {
  it('admin: the tree with kinds and the vacant position; the chart view renders an SVG', async () => {
    const { router } = await renderAs(ADMIN, '/org');
    const tree = await screen.findByRole('tree', { name: 'شجرة الهيكل الإداري' }, T);
    expect(within(tree).getByRole('treeitem', { name: 'إدارة إدارة العمليات الميدانية' })).toBeInTheDocument();
    expect(within(tree).getAllByText('شاغر').length).toBe(1);
    expect(screen.getByRole('button', { name: 'إضافة وحدة' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('مخطط'));
    await waitFor(() => expect(router.state.location.search).toContain('view=chart'));
    const chart = await screen.findByRole('application', { name: 'مخطط الهيكل الإداري' }, T);
    expect(chart.querySelector('svg')).not.toBeNull();
    expect(within(chart).getAllByRole('listitem').length).toBeGreaterThan(3);
  }, 30_000);

  it('supervisor: read-only (no add, no drag handles, no menus)', async () => {
    await renderAs(SUP1, '/org');
    await screen.findByRole('tree', {}, T);
    expect(screen.queryByRole('button', { name: 'إضافة وحدة' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^اسحب / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^إجراءات / })).toBeNull();
  }, 30_000);
});

describe('violation without a person: OCR panel → suggestion → assignment', () => {
  // The drawer's Leaflet map cannot run in jsdom, so the assignment section is rendered on its own,
  // fed by the same query (useViolation polls while the card is being read).
  function Harness({ id }: { id: string }) {
    const q = useViolation(id);
    return q.data ? <AssignSection v={q.data} /> : null;
  }

  it('admin: the reading shows the ID and the exact match; «إسناد» fills the person and the team at captured_at', async () => {
    const api = new DemoApi({ dbName: `nuzli-a9c-ocr-${Math.random()}` });
    // The seeded card of violation 1 belongs to member 2 (ID 1412345678).
    api.ocrEngine = async () => ({
      async recognize() {
        const lines = ['بطاقة تجريبية — ليست وثيقة حقيقية', 'الاسم: إبراهيم سعد الجهني', 'رقم الهوية', '1412345678', 'الجنسية: سعودي'];
        return { text: lines.join('\n'), confidence: 90, lines: lines.map((text) => ({ text, confidence: 90 })) };
      },
      async terminate() {},
    });
    const session = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    api.setAccessToken(session.accessToken);
    useAuthStore.setState({ status: 'authenticated', user: session.user, accessToken: session.accessToken });
    const router = createMemoryRouter([{ path: '*', element: <Harness id={UNASSIGNED_1} /> }]);
    render(
      <AppProviders api={api}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(await screen.findByText('بيانات البطاقة (قراءة آلية)', {}, T)).toBeInTheDocument();
    expect(await screen.findByText('تمت القراءة', {}, { timeout: 15_000 })).toBeInTheDocument();
    expect(await screen.findByText('1412345678', {}, T)).toBeInTheDocument();
    expect(screen.getByText('مطابقة رقم الهوية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إسناد المخالفة إلى إبراهيم سعد الجهني' }));
    fireEvent.click(await screen.findByRole('button', { name: 'إسناد المخالفة' }, T));
    await waitFor(async () => expect((await api.violations.get(UNASSIGNED_1)).member?.fullName).toBe('إبراهيم سعد الجهني'), T);
    expect((await api.violations.get(UNASSIGNED_1)).team?.id).toBe(TEAM1);
  }, 45_000);
});
