/**
 * Calculations audit H1 in the UI (DemoApi): a group's status is shown but not editable («تُحسب
 * من مهامها»), and a leaf's status ↔ progress sync is visible at once in the list and the board —
 * moving a card to «مكتملة» shows 100 %.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../app/App';
import { createTestRouter } from '../../app/router';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';

const ADMIN = 'admin1@demo.nuzli.example';
const T = { timeout: 20_000 };

async function setup(view: 'list' | 'board') {
  const api = new DemoApi({ dbName: `nuzli-sync-${Math.random()}` });
  const s = await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  const project = await api.projects.create({ name: 'مزامنة الحالة', startDate: '2027-03-07' });
  const g = await api.tasks.create(project.id, { name: 'المرحلة', startDate: '2027-03-07', durationDays: 1 });
  const a = await api.tasks.create(project.id, { name: 'الحفر', startDate: '2027-03-07', durationDays: 2, parentId: g.id, progress: 30, status: 'IN_PROGRESS' });
  const b = await api.tasks.create(project.id, { name: 'الصب', startDate: '2027-03-09', durationDays: 2, parentId: g.id });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  render(
    <AppProviders api={api}>
      <RouterProvider router={createTestRouter(`/projects/${project.id}?view=${view}`)} />
    </AppProviders>,
  );
  return { api, project, g, a, b };
}

describe('list view — group status derived, leaf status ↔ progress', () => {
  it('the group select is disabled with «تُحسب من مهامها»; «مكتملة» on a leaf shows 100 % and the group follows', async () => {
    const { api, project, a } = await setup('list');
    const groupStatus = await screen.findByRole('combobox', { name: /الحالة — تُحسب من مهامها/ }, T);
    expect(groupStatus).toBeDisabled();
    const statuses = await screen.findAllByRole('combobox', { name: 'الحالة' }, T);
    expect(statuses).toHaveLength(2);
    const progress = () => screen.getAllByRole('textbox', { name: 'نسبة الإنجاز' });
    expect(progress()[0]).toHaveValue('30٪');
    fireEvent.change(statuses[0]!, { target: { value: 'DONE' } });
    await waitFor(() => expect(progress()[0]).toHaveValue('100٪'), T);
    await waitFor(async () => expect((await api.projects.gantt(project.id)).tasks.find((x) => x.id === a.id)).toMatchObject({ status: 'DONE', progress: 100 }), T);
    // b to «مكتملة» too → the group becomes «مكتملة» (derived), still not editable.
    fireEvent.change(screen.getAllByRole('combobox', { name: 'الحالة' })[1]!, { target: { value: 'DONE' } });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /الحالة — تُحسب من مهامها/ })).toHaveValue('DONE'), T);
  }, 60_000);

  it('100 % in the progress cell sets «مكتملة»', async () => {
    await setup('list');
    const input = (await screen.findAllByRole('textbox', { name: 'نسبة الإنجاز' }, T))[1]!;
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getAllByRole('combobox', { name: 'الحالة' })[1]).toHaveValue('DONE'), T);
  }, 60_000);
});

describe('board — a card moved to «مكتملة» shows 100 %', () => {
  it('moves with the keyboard; the card reads 100 % and the server agrees', async () => {
    const { api, project, a } = await setup('board');
    const card = () => screen.getByRole('button', { name: /^الحفر — / });
    await screen.findByRole('button', { name: 'الحفر — قيد التنفيذ' }, T);
    expect(card()).toHaveTextContent('30٪');
    // ← is the next column in RTL: قيد التنفيذ → معلّقة → مكتملة.
    fireEvent.keyDown(card(), { key: 'ArrowLeft' });
    await screen.findByRole('button', { name: /^الحفر — معلّقة/ }, T);
    await waitFor(async () => expect((await api.projects.gantt(project.id)).tasks.find((x) => x.id === a.id)!.status).toBe('ON_HOLD'), T);
    fireEvent.keyDown(card(), { key: 'ArrowLeft' });
    await waitFor(() => expect(card()).toHaveTextContent('100٪'), T);
    expect(card()).toHaveAccessibleName(/مكتملة/);
    await waitFor(async () => expect((await api.projects.gantt(project.id)).tasks.find((x) => x.id === a.id)).toMatchObject({ status: 'DONE', progress: 100 }), T);
  }, 60_000);
});
