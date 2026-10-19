/**
 * The A9 record flow (owner decision 4, ADR-103): person photo → ID card → evidence → type and
 * description → the person (optional, «لا أعرفه — سأسنده لاحقًا» by default). «التالي» stays off
 * until each required photo exists; saving without a member puts PERSON + ID_CARD + EVIDENCE in
 * the outbox, which then syncs to an unassigned violation.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';
import { offlineDb, setMeta } from '../../features/violations/offline/db';
import { RecordViolationPage } from './RecordViolationPage';

vi.mock('../../features/violations/offline/capture', () => ({
  compressImage: async () => {
    const b = new Uint8Array(64);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    return new Blob([b], { type: 'image/jpeg' });
  },
  getPosition: async () => ({ latitude: 24.71, longitude: 46.67, accuracyM: 8, at: new Date().toISOString() }),
  deviceInfo: () => ({ userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test' }),
  deviceLabel: () => 'vitest',
}));

const T = { timeout: 10_000 };
const TYPE = { id: '00000000-0000-4000-8000-d10000000001', name: 'عدم ارتداء السترة العاكسة (تجريبي)', severity: 'MEDIUM' as const, isActive: true };

function pick(input: HTMLInputElement) {
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'p.jpg', { type: 'image/jpeg' })] } });
}

describe('record a violation without knowing the person (A9)', () => {
  it('requires person, ID card and evidence; saves with no member; the outbox holds the three kinds', async () => {
    const api = new DemoApi({ dbName: `nuzli-rec-${Math.random()}` });
    api.ocrEngine = async () => ({ async recognize() { return { text: '', confidence: 0, lines: [] }; }, async terminate() {} });
    const session = await api.auth.login({ identifier: 'monitor1@demo.nuzli.example', password: DEMO_PASSWORD });
    api.setAccessToken(session.accessToken);
    useAuthStore.setState({ status: 'authenticated', user: session.user, accessToken: session.accessToken });
    await setMeta(offlineDb(), 'types', [TYPE]);
    const router = createMemoryRouter([{ path: '/violations/new', element: <RecordViolationPage /> }], { initialEntries: ['/violations/new'] });
    render(
      <AppProviders api={api}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    const next = () => screen.getByRole('button', { name: 'التالي' });

    // 1. Person photo (required).
    expect(await screen.findByText('صورة الشخص', {}, T)).toBeInTheDocument();
    expect(next()).toBeDisabled();
    pick(document.querySelector('input[type=file]') as HTMLInputElement);
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    // 2. ID card (required).
    expect(await screen.findByText('صورة بطاقة الهوية', {}, T)).toBeInTheDocument();
    expect(next()).toBeDisabled();
    pick(document.querySelector('input[type=file]') as HTMLInputElement);
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    // 3. Evidence (≥ 1).
    expect(await screen.findByText('صور المخالفة', {}, T)).toBeInTheDocument();
    expect(next()).toBeDisabled();
    pick(document.querySelector('input[type=file]') as HTMLInputElement);
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    // 4. Type and description: «التالي» refuses an empty form.
    expect(await screen.findByText('نوع المخالفة', {}, T)).toBeInTheDocument();
    fireEvent.click(next());
    expect(await screen.findByText('النوع والوصف', {}, T)).toBeInTheDocument();
    fireEvent.click(screen.getByText(TYPE.name));
    fireEvent.change(screen.getByRole('textbox', { name: /وصف المخالفة/ }), { target: { value: 'دون سترة قرب المسار' } });
    fireEvent.click(next());
    // 5. The person: «لا أعرفه» is the default.
    const unknown = await screen.findByRole('radio', { name: /لا أعرفه — سأسنده لاحقًا/ }, T);
    expect(unknown).toBeChecked();
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ المخالفة' })).toBeEnabled(), T);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المخالفة' }));
    expect((await screen.findAllByText(/^(حُفظت المخالفة — ستُرسل عند توفّر الاتصال|أُرسلت المخالفة)$/, {}, T)).length).toBeGreaterThan(0);

    const items = await offlineDb().outbox.where('userId').equals(session.user.id).toArray();
    const item = items[items.length - 1]!;
    expect(item.payload.memberId).toBeUndefined();
    expect(item.payload.expectedPersonPhotos).toBe(1);
    expect(item.display.unassigned).toBe(true);
    expect(item.photos.map((p) => p.kind)).toEqual(['PERSON', 'ID_CARD', 'EVIDENCE']);
    // The engine sends it: an unassigned violation with the three kinds on the server.
    await waitFor(async () => expect((await offlineDb().outbox.get(item.id))?.status).toBe('synced'), { timeout: 15_000 });
    const v = (await api.violations.mine({ pageSize: 200 })).items.find((x) => x.clientUuid === item.id)!;
    expect(v.member).toBeNull();
    expect(v.files.map((f) => f.kind).sort()).toEqual(['EVIDENCE', 'ID_CARD', 'PERSON']);
  }, 60_000);
});
