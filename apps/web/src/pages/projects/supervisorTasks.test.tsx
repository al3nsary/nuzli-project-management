/**
 * Owner request A9 on the supervisor side: «اجعل المشرف لا يرى إدارة المشروع، فقط يرى المهام
 * المسندة إليه … ويضع ملاحظات مثل الشات». A supervisor cannot reach project routes and has no
 * project items in the nav; «مهامي» lists their tasks (no project links); the task page shows the
 * chat; a supervisor's message reaches the admin in the same thread; the checklist is tick-only.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';
import { TaskChat } from '../../features/chat/TaskChat';
import { useGantt } from '../../api/projectQueries';
import { useProjectWrites } from '../../api/projectWrites';
import { TaskDrawer } from './TaskDrawer';

const SUP = 'supervisor1@demo.nuzli.example';
const ADMIN = 'admin1@demo.nuzli.example';
const PARK = '00000000-0000-4000-8000-f00000000001';

const freshApi = () => new DemoApi({ dbName: `nuzli-sup-${Math.random()}` });

async function renderAt(api: DemoApi, identifier: string, path: string) {
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  const view = render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, view };
}

describe('supervisor scope (ADR-092)', () => {
  it('shows «لا تملك صلاحية» on /projects and /projects/:id, and the nav has no project items', async () => {
    const api = freshApi();
    const { view } = await renderAt(api, SUP, '/projects');
    expect(await screen.findByText('لا تملك صلاحية هذه الصفحة', {}, { timeout: 8000 })).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'القائمة الرئيسية' });
    expect(within(nav).queryByRole('link', { name: /كل المشاريع/ })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /المحافظ/ })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /عبء العمل/ })).toBeNull();
    expect(within(nav).getByRole('link', { name: /مهامي/ })).toBeInTheDocument();
    view.unmount();

    await renderAt(api, SUP, `/projects/${PARK}`);
    expect(await screen.findByText('لا تملك صلاحية هذه الصفحة', {}, { timeout: 8000 })).toBeInTheDocument();
    // The API agrees.
    await expect(api.projects.gantt(PARK)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it('lists the assigned tasks in «مهامي» without links to projects, and opens the chat page', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const mine = await api.tasks.mine();
    expect(mine.length).toBeGreaterThan(0);
    const { router } = await renderAt(api, SUP, '/my-tasks');
    const first = mine.find((x) => x.status !== 'DONE') ?? mine[0]!;
    const card = await screen.findByRole('link', { name: new RegExp(first.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }, { timeout: 8000 });
    expect(card).toHaveAttribute('href', `/my-tasks/${first.id}`);
    expect(document.querySelector('a[href^="/projects"]')).toBeNull();

    fireEvent.click(card);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/my-tasks/${first.id}`));
    expect(await screen.findByRole('log', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: first.name })).toBeInTheDocument();
  }, 30_000);

  it('answers a task that is not theirs with the friendly «لا تملك هذه المهمة» state', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    const g = await api.projects.gantt(PARK);
    const supId = '00000000-0000-4000-8000-000000000003';
    // A12 round 2: the other supervisors of the same teams are the supervisor's team (their tasks are
    // readable), so «not theirs» is a task assigned to nobody.
    void supId;
    const other = g.tasks.find((x) => !x.assignee && x.type !== 'GROUP');
    expect(other).toBeTruthy();
    await renderAt(api, SUP, `/my-tasks/${other!.id}`);
    expect(await screen.findByText('لا تملك هذه المهمة أو لم تعد مسندة إليك', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /العودة إلى مهامي/ })).toHaveAttribute('href', '/my-tasks');
  }, 30_000);

  it('a supervisor message reaches the admin in the same thread', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const task = (await api.tasks.mine())[0]!;
    const { view } = await renderAt(api, SUP, `/my-tasks/${task.id}`);
    const input = await screen.findByRole('textbox', { name: 'نص الملاحظة' }, { timeout: 8000 });
    fireEvent.change(input, { target: { value: 'تم تركيب الإنارة في الممر الشمالي' } });
    fireEvent.click(screen.getByRole('button', { name: 'إرسال الملاحظة' }));
    const log = screen.getByRole('log');
    await within(log).findByText('تم تركيب الإنارة في الممر الشمالي', {}, { timeout: 8000 });
    view.unmount();

    // The admin opens the same task's chat.
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
    render(
      <AppProviders api={api}>
        <div style={{ height: 600 }}>
          <TaskChat taskId={task.id} taskName={task.name} projectId={task.projectId} assignee={task.assignee} />
        </div>
      </AppProviders>,
    );
    const adminLog = await screen.findByRole('log', {}, { timeout: 8000 });
    const msg = await within(adminLog).findByText('تم تركيب الإنارة في الممر الشمالي', {}, { timeout: 8000 });
    // For the admin it is someone else's message (inline start) and it was unread.
    expect(msg.closest('[data-testid="chat-message"]')).not.toHaveAttribute('data-mine');
    expect(await within(adminLog).findByTestId('chat-unread')).toBeInTheDocument();
  }, 30_000);

  it('lets the supervisor tick the checklist but not edit its text', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const mine = await api.tasks.mine();
    let target: { id: string; itemText: string; itemId: string; done: boolean } | null = null;
    for (const task of mine) {
      const items = await api.tasks.checklist(task.id);
      if (items.length) {
        target = { id: task.id, itemText: items[0]!.text, itemId: items[0]!.id, done: items[0]!.done };
        break;
      }
    }
    if (!target) {
      // Seed one item as the admin when the demo has none on the supervisor's tasks.
      await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
      const item = await api.tasks.addChecklistItem(mine[0]!.id, { text: 'تصوير الموقع بعد الانتهاء' });
      target = { id: mine[0]!.id, itemText: item.text, itemId: item.id, done: false };
    }
    await renderAt(api, SUP, `/my-tasks/${target.id}?view=details`);
    const box = await screen.findByRole('checkbox', { name: new RegExp(target.itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }, { timeout: 8000 });
    expect(box).not.toBeDisabled();
    // No text editing, deleting, reordering or adding for a supervisor.
    expect(screen.queryByRole('button', { name: /^تعديل «/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^حذف «/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^اسحب لإعادة ترتيب/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'بند تحقق جديد' })).toBeNull();

    fireEvent.click(box);
    await waitFor(async () => {
      const items = await api.tasks.checklist(target!.id);
      expect(items.find((i) => i.id === target!.itemId)?.done).toBe(!target!.done);
    });
  }, 30_000);
});

/** The drawer as ProjectPage mounts it, without the rest of the project page. */
function DrawerHarness({ projectId, taskId }: { projectId: string; taskId: string }) {
  const gantt = useGantt(projectId);
  const writes = useProjectWrites(projectId);
  if (!gantt.data) return null;
  return <TaskDrawer data={gantt.data} taskId={taskId} writes={writes} onClose={() => undefined} />;
}

describe('admin task drawer tabs', () => {
  it('opens the checklist tab with edit controls and toggles a label', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    const g = await api.projects.gantt(PARK);
    const leaf = g.tasks.find((x) => !g.tasks.some((c) => c.parentId === x.id) && x.type === 'TASK')!;
    await api.tasks.addChecklistItem(leaf.id, { text: 'فحص التمديدات' });
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
    const router = createMemoryRouter([{ path: '*', element: <DrawerHarness projectId={PARK} taskId={leaf.id} /> }], { initialEntries: ['/x?ttab=checklist'] });
    render(
      <AppProviders api={api}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(await screen.findByRole('button', { name: 'تعديل «فحص التمديدات»' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'اسحب لإعادة ترتيب «فحص التمديدات»' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'بند تحقق جديد' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'التسميات والحقول المخصّصة' }));
    await waitFor(() => expect(router.state.location.search).toContain('ttab=meta'));
    const label = g.labels!.find((l) => !(leaf.labelIds ?? []).includes(l.id))!;
    const toggle = await screen.findByRole('button', { name: label.name });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('button', { name: label.name })).toHaveAttribute('aria-pressed', 'true'), { timeout: 8000 });
    expect((await api.tasks.labels(leaf.id)).map((l) => l.id)).toContain(label.id);
  }, 40_000);
});
