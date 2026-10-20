/**
 * A12 round 2 — workers' add / remove requests in the web: a supervisor's «إضافة عضو» becomes a
 * request (202 → «أُرسل الطلب للاعتماد», no member yet), it is listed in «طلبات العمّال», and an
 * admin approves it from «الطلبات» › «طلبات العمّال» (the worker joins the team) or rejects one with
 * a reason. A supervisor's «طلب إزالة» is a request too.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';

const SUP = 'supervisor1@demo.nuzli.example';
const ADMIN = 'admin1@demo.nuzli.example';
const TEAM = '00000000-0000-4000-8000-a00000000001';

const freshApi = () => new DemoApi({ dbName: `nuzli-wr-${Math.random()}` });

function validId(): string {
  const first9 = `1${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  return `${first9}${nationalIdCheckDigit(first9)}`;
}

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

describe('worker requests (طلبات العمّال)', () => {
  it('supervisor add → 202 toast → listed in /worker-requests → admin approves in «الطلبات»', async () => {
    const api = freshApi();
    const name = 'ياسر بن حمد العنزي';
    const { view } = await renderAt(api, SUP, `/teams/${TEAM}`);
    fireEvent.click(await screen.findByRole('button', { name: 'إضافة عضو' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('member-add-request-hint')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'الاسم الكامل' }), { target: { value: name } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /رقم الهوية/ }), { target: { value: validId() } });
    fireEvent.click(within(dialog).getByTestId('member-add-submit'));
    expect(await screen.findByText(/أُرسل الطلب للاعتماد/, {}, { timeout: 8000 })).toBeInTheDocument();
    // Nothing is created until an approver decides.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await api.teams.get(TEAM)).members.some((m) => m.fullName === name)).toBe(false);
    view.unmount();

    const sup = await renderAt(api, SUP, '/worker-requests');
    const pending = await screen.findByTestId('worker-requests-pending', {}, { timeout: 10_000 });
    const card = (await within(pending).findByText(name)).closest('[data-testid="worker-request"]') as HTMLElement;
    expect(within(card).getByTestId('worker-request-status')).toHaveTextContent('بانتظار القرار');
    // A supervisor cannot decide.
    expect(within(card).queryByTestId('worker-request-approve')).toBeNull();
    sup.view.unmount();

    await renderAt(api, ADMIN, '/registrations?tab=workers');
    expect(await screen.findByTestId('requests-tab-workers', {}, { timeout: 10_000 })).toHaveAttribute('aria-selected', 'true');
    const list = await screen.findByTestId('worker-requests-pending', {}, { timeout: 10_000 });
    const mine = (await within(list).findByText(name)).closest('[data-testid="worker-request"]') as HTMLElement;
    fireEvent.click(within(mine).getByTestId('worker-request-approve'));
    await waitFor(async () => expect((await api.teams.get(TEAM)).members.some((m) => m.fullName === name)).toBe(true), { timeout: 8000 });
    expect(await screen.findByText(new RegExp(`اعتُمد طلب إضافة عامل: ${name}`))).toBeInTheDocument();

    // The seeded request is rejected with a reason (required).
    const seeded = (await within(list).findByText('سعيد بن مبارك القرني')).closest('[data-testid="worker-request"]') as HTMLElement;
    fireEvent.click(within(seeded).getByTestId('worker-request-reject'));
    const reject = await screen.findByRole('dialog');
    fireEvent.click(within(reject).getByTestId('worker-request-reject-confirm'));
    expect(await within(reject).findByText('اكتب السبب (3 أحرف على الأقل).')).toBeInTheDocument();
    fireEvent.change(within(reject).getByTestId('worker-request-reject-reason'), { target: { value: 'العدد مكتمل لهذا الموسم' } });
    fireEvent.click(within(reject).getByTestId('worker-request-reject-confirm'));
    await waitFor(async () => {
      const all = await api.memberRequests.list({ status: 'REJECTED' });
      expect(all.items.some((r) => r.payload.fullName === 'سعيد بن مبارك القرني' && r.decisionReason === 'العدد مكتمل لهذا الموسم')).toBe(true);
    }, { timeout: 8000 });
  }, 60_000);

  it('a supervisor’s «طلب إزالة» on a worker of their team is a request; an admin removes directly', async () => {
    const api = freshApi();
    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const worker = (await api.teams.get(TEAM)).members.find((m) => !m.isForeman)!;
    await renderAt(api, SUP, `/teams/${TEAM}`);
    const row = (await screen.findByRole('button', { name: new RegExp(`^طلب إزالة: ${worker.fullName}`) }, { timeout: 10_000 }));
    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('member-remove-reason'), { target: { value: 'انتقل إلى مشروع آخر' } });
    fireEvent.click(within(dialog).getByTestId('member-remove-confirm'));
    expect(await screen.findByText(/أُرسل الطلب للاعتماد/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect((await api.teams.get(TEAM)).members.some((m) => m.id === worker.id)).toBe(true);
    const pending = await api.memberRequests.list({ status: 'PENDING' });
    expect(pending.items.some((r) => r.kind === 'REMOVE' && r.member?.id === worker.id)).toBe(true);
    cleanup();

    // The admin removes at once from the member drawer (archive, nothing deleted).
    await renderAt(api, ADMIN, `/teams/${TEAM}?member=${worker.id}`);
    const drawer = await screen.findByRole('dialog', {}, { timeout: 10_000 });
    fireEvent.click(await within(drawer).findByTestId('member-remove-request', {}, { timeout: 8000 }));
    fireEvent.change(await screen.findByTestId('member-remove-reason', {}, { timeout: 8000 }), { target: { value: 'انتهى العقد' } });
    fireEvent.click(screen.getByTestId('member-remove-confirm'));
    expect(await screen.findByText(new RegExp(`أُزيل ${worker.fullName}`), {}, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(async () => expect((await api.teams.get(TEAM)).members.some((m) => m.id === worker.id)).toBe(false));
  }, 40_000);
});
