/**
 * A12 web — workspaces in the shell: single-workspace mode looks as before (the name under the
 * logo, no picker, no switcher); several workspaces → «اختر القسم» after sign-in; switching from
 * the top-bar menu issues a new session and drops the previous workspace's device data (the
 * query cache and the offline outbox).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { AppProviders, createQueryClient } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';
import { offlineDb } from '../violations/offline/db';

const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

async function renderAs(api: DemoApi, identifier: string, path = '/', qc?: QueryClient) {
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null, workspaces: [], activeWorkspace: null, singleWorkspace: true });
  const router = createTestRouter(path);
  render(
    <AppProviders api={api} queryClient={qc}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return router;
}

async function withSecondWorkspace(api: DemoApi) {
  const s = await api.auth.login({ identifier: 'mmansary', password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  const ws = await api.workspaces.create({ name: 'قسم الصيانة' });
  // admin1 becomes an admin there too (a dual role, confirmed).
  await api.workspaces.addAdmin(ws.id, { identifier: 'admin1', confirmDualRole: true });
  await api.users.create({
    username: 'ws2-sup',
    fullName: 'مشرف قسم الصيانة',
    email: 'ws2-sup@a12.example',
    mobile: '0558440001',
    nationalId: validId('106644001'),
    memberships: [{ workspaceId: ws.id, role: 'SUPERVISOR' }],
  });
  api.setAccessToken(null);
  return ws;
}

describe('single-workspace mode (the UI as before)', () => {
  it('shows «إدارة المشاريع» under the logo; no picker; no workspace list in the user menu', async () => {
    const api = new DemoApi({ dbName: `nuzli-ws-ui-${Math.random()}` });
    const router = await renderAs(api, 'admin1');
    expect(await screen.findByTestId('ws-name', {}, { timeout: 8000 })).toHaveTextContent('إدارة المشاريع');
    expect(router.state.location.pathname).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'قائمة الحساب' }));
    await screen.findByRole('menuitem', { name: /ملفي الشخصي/ });
    expect(screen.queryByText('الأقسام')).toBeNull();
  });
});

describe('several workspaces', () => {
  it('«اختر القسم» after sign-in, then the switcher clears the previous workspace’s device data', async () => {
    const api = new DemoApi({ dbName: `nuzli-ws-ui-${Math.random()}` });
    const ws2 = await withSecondWorkspace(api);
    const qc = createQueryClient();
    const router = await renderAs(api, 'admin1', '/teams', qc);

    // The picker: one card per workspace with the role there.
    const card = await screen.findByRole('listitem', { name: 'الدخول إلى إدارة المشاريع' }, { timeout: 8000 });
    expect(router.state.location.pathname).toBe('/choose-workspace');
    expect(screen.getByRole('listitem', { name: 'الدخول إلى قسم الصيانة' })).toBeInTheDocument();
    fireEvent.click(card);
    await waitFor(() => expect(router.state.location.pathname).toBe('/teams'), { timeout: 8000 });
    expect(await screen.findByTestId('ws-name')).toHaveTextContent('إدارة المشاريع');
    expect(await screen.findByText('فريق الصيانة الميدانية', {}, { timeout: 8000 })).toBeInTheDocument();

    // Device data of «إدارة المشاريع»: a cached query and a violation waiting in the outbox.
    qc.setQueryData(['sentinel', 'workspace-A'], { secret: true });
    await offlineDb().outbox.put({ id: 'outbox-sentinel', userId: 'x', status: 'PENDING', createdAt: new Date().toISOString() } as never);

    fireEvent.click(screen.getByRole('button', { name: 'قائمة الحساب' }));
    const item = await screen.findByTestId(`ws-switch-${ws2.code}`);
    fireEvent.click(item);
    // Unsynced violations → the warning first.
    const go = await screen.findByRole('button', { name: 'التبديل ومسح ما لم يُرسل' });
    fireEvent.click(go);
    await waitFor(() => expect(useAuthStore.getState().activeWorkspace?.id).toBe(ws2.id), { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('ws-name')).toHaveTextContent('قسم الصيانة'));
    expect(qc.getQueryData(['sentinel', 'workspace-A'])).toBeUndefined();
    expect(await offlineDb().outbox.count()).toBe(0);
    expect(router.state.location.pathname).toBe('/');
    // The empty workspace: no teams of the other one.
    router.navigate('/teams');
    const main = await screen.findByRole('main');
    await waitFor(() => expect(within(main).queryByText('فريق الصيانة الميدانية')).toBeNull());
  }, 40_000);
});

describe('registration: the workspace step only with several workspaces', () => {
  async function renderRegister(api: DemoApi) {
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null, workspaces: [], activeWorkspace: null, singleWorkspace: true });
    const router = createTestRouter('/register');
    render(
      <AppProviders api={api}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    return router;
  }

  it('one workspace: no step (as before)', async () => {
    const api = new DemoApi({ dbName: `nuzli-ws-reg-${Math.random()}` });
    await renderRegister(api);
    await screen.findByRole('button', { name: 'تقديم طلب التسجيل' }, { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId('register-workspace')).toBeNull();
  });

  it('two workspaces: the applicant chooses the workspace by name', async () => {
    const api = new DemoApi({ dbName: `nuzli-ws-reg-${Math.random()}` });
    await withSecondWorkspace(api);
    await api.auth.logout();
    await renderRegister(api);
    expect(await screen.findByTestId('register-workspace', {}, { timeout: 8000 })).toBeInTheDocument();
  });
});
