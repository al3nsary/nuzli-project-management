/**
 * Render tests of agent R's screens with the in-browser DemoApi (seed/demo/a9.json): the project
 * dashboard with its «الميزانية» section, the people tab, the workload page and the reports page.
 * ECharts is replaced by a placeholder so the tests stay fast and deterministic.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useGantt } from '../../api/projectQueries';
import type { ProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { ProjectDashboardTab } from '../projects/tabs/DashboardTab';
import { ProjectPeopleTab } from '../projects/tabs/PeopleTab';

vi.mock('echarts-for-react/lib/core', () => ({ default: () => <div data-testid="echart" /> }));

const ADMIN = 'admin1@demo.nuzli.example';
const PARK = '00000000-0000-4000-8000-f00000000001';

async function signedInApi() {
  const api = new DemoApi({ dbName: `nuzli-a9r-${Math.random()}` });
  await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  return api;
}

function TabHarness({ tab, onOpenTask }: { tab: 'dashboard' | 'people'; onOpenTask(id: string): void }) {
  const g = useGantt(PARK);
  if (!g.data) return null;
  const props = { data: g.data, writes: {} as ProjectWrites, onOpenTask, visible: () => true };
  return tab === 'dashboard' ? <ProjectDashboardTab {...props} /> : <ProjectPeopleTab {...props} />;
}

async function renderTab(tab: 'dashboard' | 'people') {
  const api = await signedInApi();
  const onOpenTask = vi.fn();
  render(
    <AppProviders api={api}>
      <MemoryRouter>
        <TabHarness tab={tab} onOpenTask={onOpenTask} />
      </MemoryRouter>
    </AppProviders>,
  );
  return { onOpenTask };
}

describe('project dashboard tab', () => {
  it('shows the KPIs, the overdue list and the budget section with SAR totals', async () => {
    const { onOpenTask } = await renderTab('dashboard');
    const dash = await screen.findByTestId('project-dashboard', {}, { timeout: 8000 });
    // KPIs from the seed: 47 leaf tasks, 7 done, 3 overdue.
    expect(within(dash).getByText('47')).toBeInTheDocument();
    expect(within(dash).getAllByText('المتأخرة').length).toBeGreaterThan(0);
    // Overdue list with «متأخرة N …» and a click that opens the task.
    const overdue = within(dash).getByRole('region', { name: 'المهام المتأخرة' });
    expect(within(overdue).getByText('متأخرة 5 أيام')).toBeInTheDocument();
    fireEvent.click(within(overdue).getByRole('button', { name: 'افتح المهمة: حماية الأشجار القائمة' }));
    expect(onOpenTask).toHaveBeenCalledWith('00000000-0000-4000-8000-d10000000009');

    // «الميزانية»: 520,000 budget, 95,950 actual, 18.5 % used (indigo meter, no warning).
    const budget = await screen.findByRole('region', { name: 'الميزانية' }, { timeout: 8000 });
    expect(await within(budget).findByText('520,000 ر.س')).toBeInTheDocument();
    expect(within(budget).getByText('95,950 ر.س')).toBeInTheDocument();
    expect(within(budget).getByText('424,050 ر.س')).toBeInTheDocument();
    const used = within(budget).getByTestId('budget-used');
    expect(used).toHaveTextContent('18.5٪');
    expect(used).not.toHaveAttribute('data-tone');
    expect(within(budget).getByRole('progressbar', { name: 'نسبة الاستهلاك' }).closest('[data-tone]')).toHaveAttribute('data-tone', 'ok');

    // Over-budget tasks highlighted, largest overrun first; a row opens the task.
    const table = within(budget).getByRole('table', { name: 'مهام تجاوزت تكلفتها المخططة' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveAttribute('data-over');
    expect(rows[0]).toHaveTextContent('تسوير الموقع');
    fireEvent.click(rows[0]!);
    expect(onOpenTask).toHaveBeenLastCalledWith('00000000-0000-4000-8000-d10000000007');

    // The breakdown switch has the three dimensions.
    expect(within(budget).getByText('المجموعة')).toBeInTheDocument();
    expect(within(budget).getByText('المسند إليه')).toBeInTheDocument();
    expect(within(budget).getByText('الوسم')).toBeInTheDocument();
  });
});

describe('project people tab', () => {
  it('lists assignees with their team name and the unassigned bucket', async () => {
    await renderTab('people');
    const people = await screen.findByTestId('project-people', {}, { timeout: 8000 });
    expect(within(people).getByText('فهد بن خالد الدوسري')).toBeInTheDocument();
    expect(within(people).getByText('فريق الصيانة الميدانية')).toHaveAttribute('data-team-color', '#1D4ED8');
    expect(within(people).getByText('مهام غير مسندة')).toBeInTheDocument();
    expect(within(people).getByText('الإجمالي')).toBeInTheDocument();
  });
});

async function renderRoute(path: string) {
  const api = await signedInApi();
  render(
    <AppProviders api={api}>
      <RouterProvider router={createTestRouter(path)} />
    </AppProviders>,
  );
}

describe('workload page', () => {
  it('renders the heat grid with overloads in red and weekends marked', async () => {
    await renderRoute('/workload?from=2026-10-18&to=2026-10-24');
    const grid = await screen.findByRole('region', { name: 'شبكة عبء العمل: الأشخاص والأيام' }, { timeout: 8000 });
    expect(within(grid).getByText('فهد بن خالد الدوسري')).toBeInTheDocument();
    const cells = grid.querySelectorAll('td.wl-cell');
    expect(cells.length).toBe(3 * 7);
    expect(grid.querySelectorAll('td.wl-cell[data-level="over"]').length).toBeGreaterThan(0);
    // Friday and Saturday columns.
    expect(grid.querySelectorAll('th.wl-day-h[data-weekend]').length).toBe(2);
  });
});

describe('reports page', () => {
  it('lists the projects with links, budget columns and the Excel export', async () => {
    await renderRoute('/reports');
    const table = await screen.findByRole('table', { name: 'ملخص المشاريع' }, { timeout: 8000 });
    const link = within(table).getByRole('link', { name: 'تأهيل حديقة الحي الشمالي (تجريبي)' });
    expect(link).toHaveAttribute('href', `/projects/${PARK}`);
    expect(within(table).getByText('520,000 ر.س')).toBeInTheDocument();
    expect(within(table).getByText('18.5٪')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير إلى إكسل' })).toBeEnabled();
  });
});

describe('portfolios page', () => {
  it('selects the first portfolio, shows its summary and reports NAME_TAKEN on the name field', async () => {
    await renderRoute('/portfolios');
    const panel = await screen.findByTestId('portfolio-panel', {}, { timeout: 8000 });
    expect(within(panel).getByRole('link', { name: 'حملة النظافة الموسمية (تجريبي)' })).toBeInTheDocument();
    expect(within(panel).getByText('520,000 ر.س')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء محفظة' }));
    const name = await screen.findByLabelText(/اسم المحفظة/);
    fireEvent.change(name, { target: { value: 'محفظة مشاريع الحدائق والنظافة (تجريبي)' } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء المحفظة' }));
    expect(await screen.findByText('هذا الاسم مستخدم مسبقًا. اختر اسمًا آخر.')).toBeInTheDocument();
  });
});
