import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { ERRORS } from '@nuzli/shared';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';

const T = { timeout: 8000 };
const OWNER = 'mmansary';

async function renderAs(identifier: string, path: string) {
  const api = new DemoApi({ dbName: `nuzli-a12-system-${Math.random()}` });
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

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
/** «إلغاء» of the dialog whose primary button is `primary` (robust while a modal transitions). */
const cancelNextTo = (primary: HTMLElement) =>
  fireEvent.click(within(primary.parentElement as HTMLElement).getByRole('button', { name: 'إلغاء', hidden: true }));

describe('Owners area — «الأقسام»', () => {
  it('lists workspaces, creates one (session leaves single-workspace mode), archives and restores it', async () => {
    const { api } = await renderAs(OWNER, '/system/workspaces');
    const first = await screen.findByTestId('ws-card-projects', {}, T);
    expect(within(first).getByText('إدارة المشاريع')).toBeInTheDocument();
    expect(useAuthStore.getState().singleWorkspace).toBe(true);

    fireEvent.click(screen.getByTestId('ws-create'));
    type(await screen.findByTestId('ws-name-input', {}, T), 'الصيانة والتشغيل');
    type(screen.getByTestId('ws-code-input'), 'maint');
    fireEvent.click(screen.getByTestId('ws-create-submit'));
    const card = await screen.findByTestId('ws-card-maint', {}, T);
    expect(within(card).getByText('الصيانة والتشغيل')).toBeInTheDocument();
    await waitFor(() => expect(useAuthStore.getState().singleWorkspace).toBe(false), T);

    // A taken code is shown under the field.
    fireEvent.click(screen.getByTestId('ws-create'));
    type(await screen.findByTestId('ws-name-input', {}, T), 'قسم آخر');
    type(screen.getByTestId('ws-code-input'), 'maint');
    fireEvent.click(screen.getByTestId('ws-create-submit'));
    expect(await screen.findByText(ERRORS.WORKSPACE_CODE_TAKEN, {}, T)).toBeInTheDocument();
    cancelNextTo(screen.getByTestId('ws-create-submit'));

    // Archive: a confirmation that says nothing is deleted.
    fireEvent.click(within(card).getByTestId('ws-archive-maint'));
    const dialog = await screen.findByRole('dialog', { name: 'أرشفة قسم «الصيانة والتشغيل»' }, T);
    expect(dialog).toHaveTextContent('لا يُحذف شيء');
    fireEvent.click(within(dialog).getByTestId('ws-archive-confirm'));
    expect(await screen.findByTestId('ws-restore-maint', {}, T)).toBeInTheDocument();
    expect((await api.workspaces.list({ status: 'ARCHIVED' })).map((w) => w.code)).toEqual(['maint']);

    // The last active workspace cannot be archived: the Arabic error stays in the dialog.
    fireEvent.click(screen.getByTestId('ws-archive-projects'));
    fireEvent.click(await screen.findByTestId('ws-archive-confirm', {}, T));
    expect(await screen.findByText(ERRORS.LAST_WORKSPACE, {}, T)).toBeInTheDocument();
    cancelNextTo(screen.getByTestId('ws-archive-confirm'));

    fireEvent.click(screen.getByTestId('ws-restore-maint'));
    fireEvent.click(await screen.findByTestId('ws-restore-confirm', {}, T));
    expect(await screen.findByTestId('ws-archive-maint', {}, T)).toBeInTheDocument();
  });

  it('shows the summary and assigns an admin by username (dual-role confirm for an existing role)', async () => {
    const { api } = await renderAs(OWNER, '/system/workspaces');
    const ws = await api.workspaces.create({ name: 'المستودعات', code: 'stores' });
    fireEvent.click(await screen.findByTestId('ws-open-projects', {}, T));
    expect(await screen.findByTestId('ws-summary', {}, T)).toHaveTextContent('المشاريع');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));

    // Reload the list (created through the api) and open the new workspace.
    fireEvent.click(await screen.findByRole('radio', { name: 'النشطة' }, T));
    fireEvent.click(await screen.findByTestId('ws-open-stores', {}, T));
    expect(await screen.findByText('لا مدير نظام لهذا القسم', {}, T)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ws-admin-add'));
    type(await screen.findByTestId('account-identifier', {}, T), 'editor1');
    fireEvent.click(screen.getByTestId('ws-admin-add-submit'));
    // editor1 is a member of «إدارة المشاريع»: a second role needs the dual-role confirmation.
    fireEvent.click(await screen.findByTestId('dual-role-confirm', {}, T));
    expect(await screen.findByTestId('ws-admin-editor1', {}, T)).toBeInTheDocument();
    const admins = await api.workspaces.admins(ws.id);
    expect(admins.map((a) => a.user.username)).toEqual(['editor1']);
    expect(admins[0]!.dualRole).toBe(true);
  });
});

describe('Owners area — «الملّاك» and «كل الحسابات»', () => {
  it('lists owners and refuses to remove the last one (LAST_OWNER in Arabic)', async () => {
    await renderAs(OWNER, '/system/owners');
    expect(await screen.findByRole('heading', { level: 1, name: 'الملّاك' }, T)).toBeInTheDocument();
    const row = await screen.findByTestId(`owner-row-${OWNER}`, {}, T);
    expect(within(row).getByText(OWNER)).toBeInTheDocument();
    fireEvent.click(within(row).getByTestId(`owner-remove-${OWNER}`));
    fireEvent.click(await screen.findByTestId('owner-remove-confirm', {}, T));
    expect(await screen.findByText(ERRORS.LAST_OWNER, {}, T)).toBeInTheDocument();
  });

  it('adds an owner from an existing account by identifier', async () => {
    const { api } = await renderAs(OWNER, '/system/owners');
    fireEvent.click(await screen.findByTestId('owner-add', {}, T));
    type(await screen.findByTestId('account-identifier', {}, T), 'viewer1');
    fireEvent.click(screen.getByTestId('owner-add-submit'));
    expect(await screen.findByTestId('owner-row-viewer1', {}, T)).toBeInTheDocument();
    expect((await api.owners.list()).map((o) => o.username)).toContain('viewer1');
  });

  it('lists every account with username, account role and every role with its workspace', async () => {
    await renderAs(OWNER, '/system/accounts');
    const row = await screen.findByTestId('account-row-assistant1', {}, T);
    expect(within(row).getByText('assistant1')).toBeInTheDocument();
    expect(within(row).getByText(/مساعد.*إدارة المشاريع/)).toBeInTheDocument();
    const owner = await screen.findByTestId(`account-row-${OWNER}`, {}, T);
    expect(within(owner).getByTestId('owner-pill')).toBeInTheDocument();
    // Opening an account shows the same editor.
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    expect(await screen.findByTestId('user-set-password', {}, T)).toBeInTheDocument();
  });

  it('is forbidden to non-owners', async () => {
    await renderAs('admin1@demo.nuzli.example', '/system/owners');
    expect(await screen.findByText('لا تملك صلاحية هذه الصفحة', {}, T)).toBeInTheDocument();
  });
});
