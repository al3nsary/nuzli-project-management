/**
 * A12 web — workspaces in the shell: single-workspace mode looks as before (the name under the
 * logo, no picker, no switcher); several workspaces → «اختر القسم» after sign-in; switching from
 * the top-bar menu issues a new session and drops the previous workspace's device data (the
 * query cache and the offline roster) — but NEVER the unsynced outbox (security review A12 H3):
 * each item keeps its workspace and is sent when that workspace is active again.
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
import { offlineDb, setMeta, type OutboxItem } from '../violations/offline/db';
import { SyncEngine } from '../violations/offline/sync';

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
  it('«اختر القسم» after sign-in, then the switcher clears the previous workspace’s cache and roster — never its unsynced violations', async () => {
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

    // Device data of «إدارة المشاريع»: a cached query, its roster, and a violation waiting in the outbox.
    const wsA = useAuthStore.getState().activeWorkspace!;
    qc.setQueryData(['sentinel', 'workspace-A'], { secret: true });
    await offlineDb().outbox.put({ id: 'outbox-sentinel', userId: 'x', workspaceId: wsA.id, workspaceName: wsA.name, status: 'pending', createdAt: new Date().toISOString() } as never);
    await offlineDb().roster.put({ memberId: 'roster-sentinel', fullName: 'عامل القسم أ', searchName: 'عامل' } as never);
    await setMeta(offlineDb(), 'rosterWorkspaceId', wsA.id);

    fireEvent.click(screen.getByRole('button', { name: 'قائمة الحساب' }));
    const item = await screen.findByTestId(`ws-switch-${ws2.code}`);
    fireEvent.click(item);
    // No warning any more: switching deletes nothing that was not sent.
    await waitFor(() => expect(useAuthStore.getState().activeWorkspace?.id).toBe(ws2.id), { timeout: 8000 });
    expect(screen.queryByRole('button', { name: 'التبديل ومسح ما لم يُرسل' })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('ws-name')).toHaveTextContent('قسم الصيانة'));
    expect(qc.getQueryData(['sentinel', 'workspace-A'])).toBeUndefined();
    // L4: A's roster left the device; H3: A's unsynced violation did not.
    expect(await offlineDb().roster.get('roster-sentinel')).toBeUndefined();
    expect(await offlineDb().outbox.get('outbox-sentinel')).toMatchObject({ workspaceId: wsA.id, status: 'pending' });
    await offlineDb().outbox.delete('outbox-sentinel');
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

describe('A12 security review H3 — the offline outbox survives «اختر القسم» (re-login of a multi-workspace monitor)', () => {
  const pendingItem = (id: string, userId: string, ws: { id: string; name: string } | null): OutboxItem => ({
    id,
    userId,
    workspaceId: ws?.id ?? null,
    workspaceName: ws?.name ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: { clientUuid: id } as never,
    display: { memberName: 'عامل', nationalIdMasked: '', teamName: null, teamColor: null, typeName: 'نوع' },
    status: 'pending',
    error: null,
    errorCode: null,
    attempts: 0,
    nextAttemptAt: 0,
    violationId: null,
    photos: [],
    syncedAt: null,
  });

  it('pending violations of A and B: sign in again → pick A → nothing deleted, B’s item waits (notice); switch to B → A’s item waits', async () => {
    const api = new DemoApi({ dbName: `nuzli-ws-h3-${Math.random()}` });
    const ws2 = await withSecondWorkspace(api);
    const s = await api.auth.login({ identifier: 'admin1', password: DEMO_PASSWORD });
    const wsA = (s.workspaces ?? []).find((w) => w.id !== ws2.id)!;
    await offlineDb().outbox.clear();
    await offlineDb().outbox.bulkPut([
      pendingItem('h3-item-a', s.user.id, { id: wsA.id, name: wsA.name }),
      pendingItem('h3-item-b', s.user.id, { id: ws2.id, name: ws2.name }),
    ]);
    await offlineDb().outboxFiles.bulkPut([
      { key: 'h3-item-a:ID_CARD:0', itemId: 'h3-item-a', kind: 'ID_CARD', order: 0, type: 'image/jpeg', size: 3, data: new ArrayBuffer(3) },
      { key: 'h3-item-b:ID_CARD:0', itemId: 'h3-item-b', kind: 'ID_CARD', order: 0, type: 'image/jpeg', size: 3, data: new ArrayBuffer(3) },
    ]);

    // 1) Signed in again: «اختر القسم» says the items are kept and where each one waits.
    const router = await renderAs(api, 'admin1', '/');
    expect(await screen.findByTestId('ws-pick-unsynced', {}, { timeout: 8000 })).toHaveTextContent('لن تُحذف');
    expect(screen.getByTestId(`ws-unsynced-${wsA.code}`)).toHaveTextContent('مخالفة واحدة لم تُرسل');
    expect(screen.getByTestId(`ws-unsynced-${ws2.code}`)).toHaveTextContent('مخالفة واحدة لم تُرسل');
    // 2) Pick A (where one of them was recorded): nothing is deleted; B's item waits and the user is told.
    fireEvent.click(screen.getByRole('listitem', { name: `الدخول إلى ${wsA.name}` }));
    await waitFor(() => expect(useAuthStore.getState().activeWorkspace?.id).toBe(wsA.id), { timeout: 8000 });
    expect(await screen.findByText(/مخالفة واحدة لم تُرسل بعد من قسم «قسم الصيانة»/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(await offlineDb().outbox.get('h3-item-a')).toBeDefined(); // sent from A (or failed with its reason) — never wiped
    expect(await offlineDb().outbox.get('h3-item-b')).toMatchObject({ workspaceId: ws2.id, status: 'pending', attempts: 0 });
    expect(await offlineDb().outboxFiles.get('h3-item-b:ID_CARD:0')).toBeDefined();
    // 3) Switch to B: A's item is still on the device, with its workspace.
    fireEvent.click(await screen.findByRole('button', { name: 'قائمة الحساب' }));
    fireEvent.click(await screen.findByTestId(`ws-switch-${ws2.code}`));
    await waitFor(() => expect(useAuthStore.getState().activeWorkspace?.id).toBe(ws2.id), { timeout: 8000 });
    expect(await offlineDb().outbox.get('h3-item-a')).toMatchObject({ workspaceId: wsA.id });
    expect(await offlineDb().outbox.get('h3-item-b')).toBeDefined();
    expect(router.state.location.pathname).toBe('/');
    await offlineDb().outbox.clear();
    await offlineDb().outboxFiles.clear();
  }, 40_000);

  it('the sync engine sends only the items of the session workspace; a pre-A12 item is adopted; no workspace chosen → nothing is sent', async () => {
    const db = offlineDb();
    await db.outbox.clear();
    await db.outbox.bulkPut([
      pendingItem('e-a', 'u1', { id: 'ws-a', name: 'A' }),
      pendingItem('e-b', 'u1', { id: 'ws-b', name: 'B' }),
      pendingItem('e-legacy', 'u1', null),
    ]);
    const sent: string[] = [];
    const fakeApi = {
      violations: {
        create: async (p: { clientUuid: string }) => {
          sent.push(p.clientUuid);
          return { violation: { id: `v-${p.clientUuid}` } };
        },
      },
    } as never;
    let ws: string | null = null;
    const engine = new SyncEngine({ api: fakeApi, db, getUserId: () => 'u1', getWorkspaceId: () => ws });
    expect(await engine.run()).toMatchObject({ synced: 0 });
    expect(sent).toEqual([]);
    ws = 'ws-b';
    await engine.run();
    expect([...sent].sort()).toEqual(['e-b', 'e-legacy']);
    expect(await db.outbox.get('e-legacy')).toMatchObject({ workspaceId: 'ws-b', status: 'synced' });
    expect(await db.outbox.get('e-a')).toMatchObject({ status: 'pending' });
    ws = 'ws-a';
    await engine.run();
    expect(sent).toContain('e-a');
    await db.outbox.clear();
  });
});
