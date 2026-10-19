/**
 * The import wizard against the in-browser DemoApi (ADR-117): source → file → preview (summary,
 * calendar, warnings, the read-only Gantt, «تعيين المسؤولين») → commit opens the new project; the
 * server-only paths explain themselves (.mpp, Jira Cloud); the Jira form validates in Arabic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../../app/App';
import { createTestRouter } from '../../../app/router';
import { DemoApi } from '../../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../../api/demo/constants';
import { useAuthStore } from '../../../stores/auth';
import { jiraFieldErrors } from './ImportWizardPage';
import { isolateRanges } from './ImportPreview';

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const T = { timeout: 15_000 };
const fx = (n: string) => readFileSync(join(process.cwd(), 'src/features/imports/__fixtures__', n));

async function renderAt(path: string) {
  const api = new DemoApi({ dbName: `nuzli-imp-${Math.random()}` });
  await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  const router = createTestRouter(path);
  render(
    <AppProviders api={api}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { api, router };
}

describe('import wizard /projects/import', () => {
  it('MS Project XML: upload → preview → map «علي» to a supervisor → create → the project opens with the hierarchy, links and hours', async () => {
    const { api, router } = await renderAt('/projects/import');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'استيراد مشروع' }, T),
    ).toBeInTheDocument();
    // Six sources and the sample files.
    for (const name of [
      'Excel',
      'CSV',
      'MS Project XML',
      'MS Project ‎.mpp',
      'Jira (ملف CSV)',
      'Jira Cloud مباشرة',
    ]) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}`) }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText('جرّب بملف نموذجي')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^MS Project XML/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=xml&step=2'));

    // A wrong file type is refused before any upload.
    const input = await screen.findByTestId('import-file-input', {}, T);
    fireEvent.change(input, { target: { files: [new File(['x'], 'plan.xlsx')] } });
    expect(await screen.findByText(/هذا المصدر يقبل ملفات ⁦\.xml⁩ فقط/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'رفع ومعاينة' })).toBeDisabled();

    fireEvent.change(input, {
      target: { files: [new File([fx('mspdi-hours.xml')], 'tower.xml', { type: 'text/xml' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'رفع ومعاينة' }));
    expect(await screen.findByText('تعيين المسؤولين', {}, T)).toBeInTheDocument();
    expect(router.state.location.search).toBe('?source=xml&step=3');

    // Summary: name, HOUR, the lunch-break calendar, stats and Arabic warnings.
    expect(screen.getByRole('textbox', { name: /^اسم المشروع/ })).toHaveValue('تشطيب البرج');
    expect(screen.getByTestId('import-unit')).toHaveTextContent('ساعات');
    expect(screen.getByTestId('import-hours')).toHaveTextContent(
      '8:00 ص – 12:00 م، 1:00 م – 5:00 م',
    );
    expect(screen.getByText('تنبيهات القراءة (3)')).toBeInTheDocument();
    expect(screen.getByText(/مسندة إلى أكثر من مورد/)).toBeInTheDocument();
    expect(screen.getByTestId('import-gantt')).toBeInTheDocument();

    // «تعيين المسؤولين»: علي → فهد, أحمد stays without an assignee.
    const table = screen.getByRole('table');
    expect(within(table).getByText('علي')).toBeInTheDocument();
    expect(within(table).getByText('أحمد')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('textbox', { name: 'المشرف المسؤول عن «علي»' }));
    fireEvent.click(await screen.findByRole('option', { name: 'فهد بن خالد الدوسري' }, T));

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء المشروع (5 مهام)' }));
    await waitFor(
      () => expect(router.state.location.pathname).toMatch(/^\/projects\/[0-9a-f-]{36}$/),
      T,
    );
    const id = router.state.location.pathname.split('/').pop()!;
    const g = await api.projects.gantt(id);
    expect(g.project).toMatchObject({ name: 'تشطيب البرج', durationUnit: 'HOUR' });
    expect(g.tasks.map((x) => x.wbs)).toEqual(['1', '1.1', '1.2', '2', '3']);
    expect(g.tasks.find((x) => x.name === 'التمديدات')!.assignee?.id).toBe(SUP1_ID);
    expect(g.dependencies).toHaveLength(3);
    expect(g.calendar.workingHours).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ]);
  });

  it('.mpp in the demo explains the converter and offers XML; Jira Cloud explains the server and offers Jira CSV', async () => {
    const { router } = await renderAt('/projects/import?source=mpp&step=2');
    expect(
      await screen.findByText(
        'يتطلّب خادم التحويل — احفظ الملف بصيغة XML من MS Project ثم ارفعه',
        {},
        T,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'استيراد ملف XML بدلًا منه' }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=xml&step=2'));

    router.navigate('/projects/import?source=jira-cloud&step=2');
    expect(await screen.findByText('الاستيراد من Jira Cloud', {}, T)).toBeInTheDocument();
    expect(screen.getByLabelText(/رمز API/)).toHaveAttribute('type', 'password');
    expect(screen.getByText(/لا يُحفظ في نُزلي ولا في المتصفح/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/رابط موقع Jira/), {
      target: { value: 'https://10.0.0.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'جلب المهام ومعاينتها' }));
    expect(
      await screen.findByText(/استخدم رابط https لموقعك على atlassian.net/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'استيراد ملف Jira CSV بدلًا منه' })[0]!);
    await waitFor(() => expect(router.state.location.search).toBe('?source=jira-csv&step=2'));
  });

  it('A10: GanttPRO and Microsoft Project come first with how-to text; a GanttPRO file chosen as «Excel» is recognised on the file step and in the preview, then created with its colours', { timeout: 60_000 }, async () => {
    const { api, router } = await renderAt('/projects/import');
    expect(await screen.findByText('مشروع جاهز من برنامج آخر', {}, T)).toBeInTheDocument();
    expect(screen.getByText('من GanttPRO: تصدير ← Excel')).toBeInTheDocument();
    expect(screen.getByText('من MS Project: حفظ باسم ← XML')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^GanttPRO \(Excel\)/ })).toBeInTheDocument();
    expect(screen.getByText('Microsoft Project (XML / MPP)')).toBeInTheDocument();

    // MS Project: one source — a .mpp picked under XML switches the reader.
    fireEvent.click(screen.getByRole('button', { name: /^MS Project XML/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=xml&step=2'));
    expect(screen.getByText('كيف تحصل على الملف')).toBeInTheDocument();
    fireEvent.change(await screen.findByTestId('import-file-input', {}, T), {
      target: { files: [new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], 'plan.mpp')] },
    });
    await waitFor(() => expect(router.state.location.search).toBe('?source=mpp&step=2'));

    // A GanttPRO export chosen as «Excel».
    await router.navigate('/projects/import?source=xlsx&step=2');
    expect(await screen.findByText('ملف Excel', {}, T)).toBeInTheDocument();
    const input = screen.getByTestId('import-file-input');
    fireEvent.change(input, {
      target: { files: [new File([fx('ganttpro-sample.xlsx')], 'villa.xlsx')] },
    });
    expect(await screen.findByTestId('import-detected-file', {}, T)).toHaveTextContent(
      'تم التعرّف على ملف GanttPRO',
    );
    fireEvent.click(screen.getByRole('button', { name: 'رفع ومعاينة' }));
    expect(await screen.findByTestId('import-detected', {}, T)).toHaveTextContent(
      'تم التعرّف على ملف GanttPRO',
    );
    expect(screen.getByTestId('import-detected')).toHaveTextContent('اخترت «Excel»');
    expect(screen.getByTestId('import-format')).toHaveTextContent('GanttPRO (Excel)');
    expect(screen.getByTestId('import-source-types')).toHaveTextContent('2 مشروع');
    expect(screen.getByTestId('import-unit')).toHaveTextContent('ساعات');
    expect(screen.getByText('الصيغة المكتشفة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^إنشاء المشروع/ }));
    await waitFor(
      () => expect(router.state.location.pathname).toMatch(/^\/projects\/[0-9a-f-]{36}$/),
      T,
    );
    const g = await api.projects.gantt(router.state.location.pathname.split('/').pop()!);
    expect(g.tasks).toHaveLength(13);
    expect(new Set(g.tasks.map((x) => x.barColor)).size).toBe(7);
  });

  it('a reload on the preview step goes back to the file step (the preview lives in memory)', async () => {
    const { router } = await renderAt('/projects/import?source=csv&step=3');
    await waitFor(() => expect(router.state.location.search).toBe('?source=csv&step=2'), T);
    expect(await screen.findByText('ملف CSV', {}, T)).toBeInTheDocument();
  });
});

describe('warning text', () => {
  it('time ranges inside the Arabic message are isolated left-to-right (no «14:00–10:00»)', () => {
    expect(isolateRanges('ساعات العمل 10:00–14:00 و15:30–20:30، والعطلة')).toBe(
      'ساعات العمل ⁦10:00–14:00⁩ و⁦15:30–20:30⁩، والعطلة',
    );
  });
});

describe('Jira form validation (instant Arabic messages)', () => {
  const base = {
    siteUrl: 'https://acme.atlassian.net',
    email: 'a@b.sa',
    apiToken: 'secret-token',
    mode: 'key' as const,
    projectKey: 'OPS',
    jql: '',
  };
  it('accepts a valid form and refuses non-Atlassian, http, IP, port and credential URLs', () => {
    expect(jiraFieldErrors(base)).toEqual({});
    for (const siteUrl of [
      'https://evil.com',
      'http://acme.atlassian.net',
      'https://169.254.169.254',
      'https://acme.atlassian.net:8443',
      'https://u:p@acme.atlassian.net',
      'https://acme.atlassian.net.evil.com',
    ]) {
      expect(jiraFieldErrors({ ...base, siteUrl }).siteUrl).toMatch(/atlassian\.net|غير صالح/);
    }
    expect(jiraFieldErrors({ ...base, siteUrl: '' }).siteUrl).toBe('حقل مطلوب');
  });
  it('e-mail, token, project key and JQL', () => {
    expect(jiraFieldErrors({ ...base, email: 'x' }).email).toBe('بريد إلكتروني غير صالح');
    expect(jiraFieldErrors({ ...base, apiToken: 'short' }).apiToken).toBe('رمز Jira غير صالح');
    expect(jiraFieldErrors({ ...base, projectKey: 'ops key' }).projectKey).toContain(
      'مفتاح مشروع Jira غير صالح',
    );
    expect(jiraFieldErrors({ ...base, projectKey: '' }).projectKey).toBe(
      'اكتب مفتاح المشروع أو استعلام JQL',
    );
    expect(jiraFieldErrors({ ...base, mode: 'jql', jql: '' }).projectKey).toBe('اكتب استعلام JQL.');
    expect(jiraFieldErrors({ ...base, mode: 'jql', jql: 'project = OPS' })).toEqual({});
  });
});
