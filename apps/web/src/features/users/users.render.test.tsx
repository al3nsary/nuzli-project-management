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

async function renderAs(identifier: string, path: string, prepare?: (api: DemoApi) => Promise<void>) {
  const api = new DemoApi({ dbName: `nuzli-a12-users-${Math.random()}` });
  if (prepare) await prepare(api);
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

/** A valid-format Saudi national ID (Luhn variant of the shared validator), random. */
function nationalId(): string {
  const d = [1, ...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10))];
  let sum = 0;
  d.forEach((x, i) => {
    if (i % 2 === 0) {
      const y = x * 2;
      sum += y > 9 ? y - 9 : y;
    } else sum += x;
  });
  return [...d, (10 - (sum % 10)) % 10].join('');
}
const mobile = () => `05${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function pickOption(input: HTMLElement, name: string) {
  fireEvent.click(input);
  fireEvent.click(await screen.findByRole('option', { name }, T));
}

describe('User management (A12 round 2)', () => {
  it('lists usernames and workspace roles, marks owners; create / add-existing for admins', async () => {
    await renderAs('admin1@demo.nuzli.example', '/users');
    const row = await screen.findByTestId('user-row-assistant1', {}, T);
    expect(within(row).getByText('assistant1')).toBeInTheDocument();
    expect(within(row).getByText('مساعد')).toBeInTheDocument();
    // The owner is marked as owner in the list.
    const owner = await screen.findByTestId('user-row-mmansary', {}, T);
    expect(within(owner).getByTestId('owner-pill')).toHaveTextContent('مالك النظام');
    expect(screen.getByTestId('user-create')).toBeInTheDocument();
    expect(screen.getByTestId('user-add-existing')).toBeInTheDocument();
  });

  it('creates a user with username, first password and role; the assistant role shows the grid', async () => {
    const { api } = await renderAs('admin1@demo.nuzli.example', '/users');
    fireEvent.click(await screen.findByTestId('user-create', {}, T));
    const dialog = await screen.findByRole('dialog', { name: 'إنشاء مستخدم' }, T);
    type(within(dialog).getByTestId('user-username'), 'new.assistant');
    type(within(dialog).getByLabelText(/الاسم الكامل/), 'سارة عبدالله القحطاني');
    type(within(dialog).getByLabelText(/البريد الإلكتروني/), 'sara.new@demo.nuzli.example');
    type(within(dialog).getByLabelText(/رقم الجوال/), mobile());
    type(within(dialog).getByLabelText(/رقم الهوية/), nationalId());
    type(within(dialog).getByTestId('user-password'), 'FirstPass2026');
    expect(within(dialog).getByRole('checkbox', { name: /يُطلب التغيير عند أول دخول/ })).toBeChecked();
    await pickOption(within(dialog).getByTestId('user-role'), 'مساعد');
    const grid = await within(dialog).findByTestId('assistant-grid', {}, T);
    fireEvent.click(within(grid).getByRole('radio', { name: 'المشاريع: اطّلاع' }));
    fireEvent.click(within(dialog).getByTestId('user-create-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'إنشاء مستخدم' })).toBeNull(), T);
    const row = await screen.findByTestId('user-row-new.assistant', {}, T);
    expect(within(row).getByText('مساعد')).toBeInTheDocument();
    // The account logs in with its first password and must change it.
    const session = await api.auth.login({ identifier: 'new.assistant', password: 'FirstPass2026' });
    expect(session.user.mustChangePassword).toBe(true);
  });

  it('changes a username (USERNAME_TAKEN under the field) and sets a new password from the drawer', async () => {
    const { api } = await renderAs('admin1@demo.nuzli.example', '/users');
    const row = await screen.findByTestId('user-row-assistant1', {}, T);
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    fireEvent.click(await screen.findByTestId('user-change-username', {}, T));
    const input = await screen.findByTestId('user-username-input', {}, T);
    type(input, 'editor1');
    fireEvent.click(screen.getByTestId('user-username-submit'));
    expect(await screen.findByText(ERRORS.USERNAME_TAKEN, {}, T)).toBeInTheDocument();
    type(input, 'assistant.one');
    fireEvent.click(screen.getByTestId('user-username-submit'));
    await waitFor(() => expect(screen.queryByTestId('user-username-input')).toBeNull(), T);

    fireEvent.click(await screen.findByTestId('user-set-password', {}, T));
    const dialog = await screen.findByRole('dialog', { name: /كلمة مرور جديدة/ }, T);
    expect(dialog).toHaveTextContent('يُسجَّل خروج هذا الشخص من كل أجهزته');
    type(within(dialog).getByTestId('user-new-password'), 'BrandNew2026x');
    fireEvent.click(within(dialog).getByTestId('user-set-password-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /كلمة مرور جديدة/ })).toBeNull(), T);
    const session = await api.auth.login({ identifier: 'assistant.one', password: 'BrandNew2026x' });
    expect(session.user.mustChangePassword).toBe(true);
  });

  it('opens the assistant membership with its grid and saves new levels', async () => {
    const { api } = await renderAs('admin1@demo.nuzli.example', '/users');
    const row = await screen.findByTestId('user-row-assistant1', {}, T);
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    fireEvent.click(await screen.findByTestId('membership-edit-ASSISTANT', {}, T));
    const grid = await screen.findByTestId('assistant-grid', {}, T);
    expect(within(grid).getByRole('radio', { name: 'المشاريع: اطّلاع' })).toBeChecked();
    fireEvent.click(within(grid).getByRole('radio', { name: 'المخالفات: اطّلاع' }));
    fireEvent.click(screen.getByTestId('membership-save'));
    await waitFor(() => expect(screen.queryByTestId('membership-save')).toBeNull(), T);
    const ws = useAuthStore.getState().activeWorkspace!;
    const members = await api.workspaces.members(ws.id);
    const m = members.find((x) => x.user.username === 'assistant1' && x.role === 'ASSISTANT');
    expect(m?.permissions.violations).toBe('view');
    expect(m?.permissions.projects).toBe('view');
  });

  it('grants a second role through the dual-role warning and shows «صلاحية مزدوجة»', async () => {
    await renderAs('admin1@demo.nuzli.example', '/users');
    const row = await screen.findByTestId('user-row-assistant1', {}, T);
    expect(within(row).queryByTestId('dual-role-badge')).toBeNull();
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'بيانات الحساب' }, T);
    fireEvent.click(await within(drawer).findByRole('button', { name: 'منح صفة' }, T));
    await pickOption(await screen.findByTestId('member-role', {}, T), 'مشرف مراقبة');
    fireEvent.click(screen.getByTestId('member-add-submit'));
    fireEvent.click(await screen.findByTestId('dual-role-confirm', {}, T));
    await waitFor(() => expect(screen.queryByTestId('member-add-submit')).toBeNull(), T);
    await waitFor(() => expect(within(screen.getByTestId('user-row-assistant1')).getByTestId('dual-role-badge')).toBeInTheDocument(), T);
  });

  it('is read-only for an assistant with users:view', async () => {
    await renderAs('assistant1', '/users', async (api) => {
      await api.auth.login({ identifier: 'admin1@demo.nuzli.example', password: DEMO_PASSWORD });
      const ws = (await api.auth.workspaces())[0]!;
      const m = (await api.workspaces.members(ws.id)).find((x) => x.user.username === 'assistant1' && x.role === 'ASSISTANT')!;
      await api.workspaces.updateMember(ws.id, m.id, { permissions: { ...m.permissions, users: 'view' } });
    });
    expect(await screen.findByTestId('user-row-assistant1', {}, T)).toBeInTheDocument();
    expect(screen.queryByTestId('user-create')).toBeNull();
    expect(screen.queryByTestId('user-add-existing')).toBeNull();
    expect(screen.getByText('حسابات هذا القسم للاطّلاع فقط.')).toBeInTheDocument();
  });
});
