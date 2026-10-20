/**
 * A12 round 2 — project participants (محرّر / مساهم / مطّلع) in the web: the access rules, the
 * «المشاركون» tab (an admin adds a person with a level and they appear), and a viewer's project
 * page (no create / edit / delete / drag, the «مشارك بصفة مطّلع» pill, no add in the tab).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';
import { projectAccess, taskAccess } from './access';
import { ProjectPage } from '../../pages/projects/ProjectPage';

const ADMIN = 'admin1@demo.nuzli.example';
const VIEWER = 'viewer1@demo.nuzli.example';
const PARK = '00000000-0000-4000-8000-f00000000001';

const freshApi = () => new DemoApi({ dbName: `nuzli-part-${Math.random()}` });

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

describe('participant access rules (docs/a12-roles.md §3)', () => {
  const member = { id: 'u1', roles: ['MEMBER'], status: 'ACTIVE' } as never;
  const admin = { id: 'a1', roles: ['ADMIN'], status: 'ACTIVE' } as never;
  const supervisor = { id: 's1', roles: ['SUPERVISOR'], status: 'ACTIVE' } as never;
  const task = { assignee: { id: 's2' } };

  it('VIEWER reads only; CONTRIBUTOR works on every task; EDITOR edits the structure — never settings or money', () => {
    const v = projectAccess(member, 'VIEWER');
    expect(v).toMatchObject({ editTasks: false, workAll: false, comment: false, manageProject: false, budgetRead: false, participantOnly: true });
    expect(taskAccess(member, 'VIEWER', task)).toMatchObject({ edit: false, status: false, comment: false, checklist: 'read', attach: false, logTime: false });

    const c = taskAccess(member, 'CONTRIBUTOR', task);
    expect(c).toMatchObject({ edit: false, status: true, comment: true, checklist: 'assignee', attach: true, logTime: true, team: false });

    const e = projectAccess(member, 'EDITOR');
    expect(e).toMatchObject({ editTasks: true, workAll: true, comment: true, manageProject: false, budgetRead: false, budgetManage: false });
    expect(taskAccess(member, 'EDITOR', task).checklist).toBe('admin');
  });

  it('an admin keeps their own rights; a supervisor on a team task comments and changes status only', () => {
    expect(projectAccess(admin, undefined)).toMatchObject({ manageProject: true, editTasks: true, budgetRead: true, participantOnly: false });
    const team = taskAccess(supervisor, undefined, task);
    expect(team).toMatchObject({ team: true, status: true, comment: true, checklist: 'read', attach: false, logTime: false, edit: false });
    const own = taskAccess(supervisor, undefined, { assignee: { id: 's1' } });
    expect(own).toMatchObject({ team: false, mine: true, status: true, checklist: 'assignee', attach: true, logTime: true });
  });
});

describe('«المشاركون» tab', () => {
  it('an admin adds a person as محرّر and the row appears; the API agrees', async () => {
    const api = freshApi();
    await renderAt(api, ADMIN, `/projects/${PARK}?view=participants`);
    const tab = await screen.findByTestId('participants-tab', {}, { timeout: 10_000 });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    // The seeded participants are listed with their level.
    const panel = await screen.findByTestId('participants-panel', {}, { timeout: 10_000 });
    await within(panel).findByText('منى بنت علي الحربي', {}, { timeout: 8000 });

    fireEvent.click(within(panel).getByTestId('participant-add'));
    const dialog = await screen.findByRole('dialog');
    const person = within(dialog).getByRole('textbox', { name: /الشخص/ });
    fireEvent.click(person);
    fireEvent.change(person, { target: { value: 'لينا' } });
    const option = await screen.findByRole('option', { name: /لينا بنت فهد الزهراني/ }, { timeout: 8000 });
    fireEvent.click(option);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /المنصب/ }), { target: { value: 'منسّقة الجودة' } });
    fireEvent.click(within(dialog).getByTestId('participant-level-EDITOR'));
    fireEvent.click(within(dialog).getByTestId('participant-submit'));

    await within(panel).findByText('لينا بنت فهد الزهراني', {}, { timeout: 8000 });
    expect(await screen.findByText(/أُضيف لينا بنت فهد الزهراني إلى المشروع بصفة محرّر/)).toBeInTheDocument();
    const added = (await api.participants.list(PARK)).find((p) => p.user.fullName === 'لينا بنت فهد الزهراني');
    expect(added).toMatchObject({ level: 'EDITOR', title: 'منسّقة الجودة' });
  }, 40_000);

  it('a duplicate is refused in Arabic (PARTICIPANT_EXISTS)', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    const viewer = (await api.participants.list(PARK)).find((p) => p.level === 'VIEWER')!;
    await expect(api.participants.add(PARK, { userId: viewer.user.id, title: 'مكرر', level: 'VIEWER' })).rejects.toMatchObject({ code: 'PARTICIPANT_EXISTS' });
  }, 20_000);
});

/**
 * The project page itself, without the app's route guard: until src/app admits participants on
 * /projects/:id (they hold no projects.readAll), the page is mounted directly.
 */
async function renderProject(api: DemoApi, identifier: string, search: string) {
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createMemoryRouter([{ path: '/projects/:id', element: <div style={{ height: 800 }}><ProjectPage /></div> }], { initialEntries: [`/projects/${PARK}${search}`] });
  return render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

describe('a viewer participant on the project page', () => {
  it('reads the list with no create / delete / edit, sees «مشارك بصفة مطّلع», and cannot add participants', async () => {
    const api = freshApi();
    const view = await renderProject(api, VIEWER, '?view=list');
    const pill = await screen.findByTestId('participant-pill', {}, { timeout: 10_000 });
    expect(pill).toHaveTextContent('مشارك بصفة مطّلع');
    // Tasks are listed…
    await waitFor(() => expect(document.querySelectorAll('[data-list-row]').length).toBeGreaterThan(0), { timeout: 10_000 });
    // …but nothing structural: no add buttons, no delete column, no rename input, no settings.
    expect(screen.queryByRole('button', { name: 'إضافة مهمة' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^حذف / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'إعدادات المشروع' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تحديد متعدد' })).toBeNull();
    // Status selects are read-only for a viewer.
    for (const sel of document.querySelectorAll('[data-list-row] select')) expect(sel).toBeDisabled();
    view.unmount();

    await renderProject(api, VIEWER, '?view=participants');
    const panel = await screen.findByTestId('participants-panel', {}, { timeout: 10_000 });
    await within(panel).findByText('خالد بن عمر السالم', {}, { timeout: 8000 });
    expect(within(panel).queryByTestId('participant-add')).toBeNull();
    expect(within(panel).queryByTestId('participant-remove')).toBeNull();
  }, 40_000);
});
