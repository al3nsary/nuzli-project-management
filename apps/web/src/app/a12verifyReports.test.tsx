/**
 * A12 verification (D5): an assistant granted ONLY the reports module (reports.read, no projects)
 * must reach «التقارير» and «عبء العمل» — the server answers both for projects.readAll OR
 * reports.read (ProjectReportsService), but the web gated them on projects.readAll alone.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import type { UserDto } from '@nuzli/shared';
import { AppProviders } from './App';
import { createTestRouter } from './router';
import { visibleNav, navLeaves } from './nav';
import { DemoApi } from '../api/demo/DemoApi';
import { useAuthStore } from '../stores/auth';
import { DEMO_PASSWORD } from '../api/demo/constants';

const reportsOnly = {
  id: 'u-assistant',
  fullName: 'لينا بنت فهد الزهراني',
  email: 'a@example.com',
  mobile: '+966500000000',
  nationalIdMasked: '1•••••••23',
  role: 'ASSISTANT',
  roles: ['ASSISTANT'],
  grants: ['reports.read'],
  status: 'ACTIVE',
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  preferences: { theme: 'auto', digits: 'latn', showHijri: false },
} as unknown as UserDto;

describe('assistant with the reports module only', () => {
  it('sees «التقارير» and «عبء العمل» in the navigation, but not the projects list', () => {
    const ids = navLeaves(visibleNav(reportsOnly, { teamViolations: false })).map((n) => n.id);
    expect(ids).toContain('reports');
    expect(ids).toContain('workload');
    expect(ids).not.toContain('projects');
  });

  it('the /reports route opens (not «لا تملك صلاحية هذه الصفحة») and project names are text, not links it cannot open', async () => {
    const api = new DemoApi({ dbName: `nuzli-rep-${Math.random()}` });
    let s = await api.auth.login({ identifier: 'admin1', password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const ws = (await api.auth.workspaces())[0]!.id;
    const m = (await api.workspaces.members(ws)).find((x) => x.user.username === 'assistant1')!;
    await api.workspaces.updateMember(ws, m.id, { permissions: { reports: 'view' }, scope: {} } as never);
    api.setAccessToken(null);
    s = await api.auth.login({ identifier: 'assistant1', password: DEMO_PASSWORD });
    useAuthStore.setState({ status: 'loading', user: null, accessToken: null, workspaces: [], activeWorkspace: null, singleWorkspace: true });
    render(
      <AppProviders api={api}>
        <RouterProvider router={createTestRouter('/reports')} />
      </AppProviders>,
    );
    expect(await screen.findByText('تأهيل حديقة الحي الشمالي (تجريبي)', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByText('لا تملك صلاحية هذه الصفحة')).toBeNull();
    expect(screen.getByText('تأهيل حديقة الحي الشمالي (تجريبي)').closest('a')).toBeNull();
    expect(screen.queryByText('اضغط اسم المشروع لفتحه')).toBeNull();
  });
});
