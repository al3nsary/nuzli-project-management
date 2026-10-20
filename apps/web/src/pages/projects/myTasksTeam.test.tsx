/**
 * A12 round 2 (owner rule) — a supervisor's «مهامي» lists their own tasks AND their team's
 * (`assignedToMe`): every card says «مسندة إليّ» or «مهمة الفريق · <assignee>», the scope chip
 * filters, and on a team task the supervisor changes status/progress and comments while the
 * checklist, attachments and time log are hidden with a one-line explanation.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';

const SUP = 'supervisor1@demo.nuzli.example';
const freshApi = () => new DemoApi({ dbName: `nuzli-mt-${Math.random()}` });

async function renderAt(api: DemoApi, path: string) {
  await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  const view = render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, view };
}

describe('«مهامي» with the team’s tasks', () => {
  it('badges every card and filters own / team tasks', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const mine = await api.tasks.mine();
    const team = mine.filter((x) => x.assignedToMe === false);
    const own = mine.filter((x) => x.assignedToMe === true);
    expect(team.length).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(0);

    const { router } = await renderAt(api, '/my-tasks');
    await waitFor(() => expect(screen.getAllByTestId('mytask-badge-team').length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(screen.getAllByTestId('mytask-badge-mine').length).toBeGreaterThan(0);
    const teamBadge = screen.getAllByTestId('mytask-badge-team')[0]!;
    expect(teamBadge.textContent).toMatch(/^مهمة الفريق · /);
    expect(screen.getAllByTestId('mytask-badge-mine')[0]).toHaveTextContent('مسندة إليّ');

    fireEvent.click(within(screen.getByTestId('mytask-scope')).getByText('مهام الفريق'));
    await waitFor(() => expect(router.state.location.search).toContain('scope=team'));
    await waitFor(() => expect(screen.queryAllByTestId('mytask-badge-mine')).toHaveLength(0));
    expect(screen.getAllByTestId('mytask-badge-team').length).toBeGreaterThan(0);

    fireEvent.click(within(screen.getByTestId('mytask-scope')).getByText('مسندة إليّ'));
    await waitFor(() => expect(screen.queryAllByTestId('mytask-badge-team')).toHaveLength(0));
  }, 40_000);

  it('a team task: status and comments yes; checklist, attachments and time log hidden with the reason', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const task = (await api.tasks.mine()).find((x) => x.assignedToMe === false && x.type !== 'GROUP')!;
    await renderAt(api, `/my-tasks/${task.id}?view=details`);
    expect(await screen.findByTestId('team-task-note', {}, { timeout: 10_000 })).toHaveTextContent('قائمة التحقق والمرفقات وسجل الوقت لصاحب المهمة.');
    expect(screen.getByRole('textbox', { name: 'الحالة' })).toBeInTheDocument();
    expect(screen.queryByText('قائمة التحقق')).toBeNull();
    expect(screen.queryByRole('button', { name: /إرفاق ملف|رفع ملف/ })).toBeNull();
  }, 40_000);
});
