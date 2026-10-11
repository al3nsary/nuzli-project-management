import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { cardTemplateConfigSchema, type CardTemplateDto } from '@nuzli/shared';
import { AppProviders } from '../app/App';
import { createTestRouter } from '../app/router';
import { DemoApi } from '../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../api/demo/constants';
import { useAuthStore } from '../stores/auth';
import { CardEditor, type EditableCard } from './cards/CardEditor';
import { useState } from 'react';
import { MantineProvider, DirectionProvider } from '@mantine/core';

async function renderAs(identifier: string, path: string) {
  const api = new DemoApi({ dbName: `nuzli-render-${Math.random()}` });
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  render(
    <AppProviders api={api}>
      <RouterProvider router={createTestRouter(path)} />
    </AppProviders>,
  );
  return api;
}

describe('Team formation page', () => {
  it('renders one column per active team (named, with supervisor) plus «بلا فريق»', async () => {
    await renderAs('admin1@demo.nuzli.example', '/teams/formation');
    const board = await screen.findByRole('region', { name: 'لوحة تشكيل الفرق' }, { timeout: 5000 });
    const columns = await within(board).findAllByRole('region');
    const names = columns.map((c) => c.getAttribute('aria-label'));
    expect(names).toContain('بلا فريق');
    expect(names).toContain('فريق فريق الصيانة الميدانية');
    expect(names).toContain('فريق فريق التشجير والري');
    // Active teams only: the pending and archived teams have no column.
    expect(names.join(' ')).not.toContain('الإرشاد والاستقبال');
    expect(names.join(' ')).not.toContain('الدعم المؤقت');
    expect(columns).toHaveLength(1 + 5);
    // Column header shows the supervisor; member cards carry a drag handle.
    const first = columns.find((c) => c.getAttribute('aria-label') === 'فريق فريق الصيانة الميدانية')!;
    expect(within(first).getByText('فهد بن خالد الدوسري')).toBeInTheDocument();
    expect(within(first).getAllByRole('button', { name: /^اسحب / }).length).toBeGreaterThan(0);
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('is hidden from supervisors (members.move is admin only)', async () => {
    await renderAs('supervisor1@demo.nuzli.example', '/teams/formation');
    expect(await screen.findByText('لا تملك صلاحية هذه الصفحة')).toBeInTheDocument();
  });
});

const TEMPLATE: CardTemplateDto = {
  id: '00000000-0000-4000-8000-110000000001',
  name: 'كلاسيكية أفقية — CR80',
  size: { id: 's', name: 'CR80', widthMm: 85.6, heightMm: 54, isBuiltin: true },
  orientation: 'LANDSCAPE',
  layoutKey: 'CLASSIC_HORIZONTAL',
  config: cardTemplateConfigSchema.parse({}),
  isDefault: true,
  logoId: null,
};

const CARD: EditableCard = {
  key: 'm:1',
  memberId: '00000000-0000-4000-8000-b00000000001',
  original: {
    fullName: 'أحمد محمد المالكي',
    jobTitle: 'عامل ميداني',
    nationalId: '1•••••••28',
    department: 'التشغيل الميداني',
    teamName: 'فريق الصيانة الميدانية',
    teamColor: '#1D4ED8',
    qrValue: '00000000-0000-4000-8000-b00000000001',
  },
  data: {
    fullName: 'أحمد محمد المالكي',
    jobTitle: 'عامل ميداني',
    nationalId: '1•••••••28',
    department: 'التشغيل الميداني',
    teamName: 'فريق الصيانة الميدانية',
    teamColor: '#1D4ED8',
    qrValue: '00000000-0000-4000-8000-b00000000001',
  },
  selected: true,
  saveBack: false,
};

function Harness() {
  const [cards, setCards] = useState<EditableCard[]>([CARD]);
  const [active, setActive] = useState<string | null>(null);
  return (
    <DirectionProvider initialDirection="rtl" detectDirection={false}>
      <MantineProvider>
        <CardEditor
          template={TEMPLATE}
          logoUrl={null}
          cards={cards}
          activeKey={active}
          onActivate={setActive}
          onChange={setCards}
        />
      </MantineProvider>
    </DirectionProvider>
  );
}

describe('Card editor preview', () => {
  it('renders the work card and applies an inline edit to the live preview', async () => {
    render(<Harness />);
    const list = screen.getByRole('list', { name: 'معاينة الكروت' });
    expect(within(list).getAllByText('أحمد محمد المالكي').length).toBeGreaterThan(0);
    expect(list.querySelector('.nz-card')).not.toBeNull();
    // The team name is printed with its colour strip.
    expect(within(list).getByText('فريق الصيانة الميدانية')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تعديل كرت أحمد محمد المالكي' }));
    const editor = screen.getByTestId('card-editor');
    const name = within(editor).getByLabelText('الاسم');
    fireEvent.change(name, { target: { value: 'أحمد المالكي المعدّل' } });
    expect(within(list).getAllByText('أحمد المالكي المعدّل').length).toBeGreaterThan(0);
    expect(screen.getByText('معدّل لهذه الدفعة')).toBeInTheDocument();
    // Save-back is offered for member cards once something changed.
    const saveBack = within(editor).getByLabelText('حفظ في سجل العضو');
    expect(saveBack).not.toBeDisabled();
    fireEvent.click(saveBack);
    expect(screen.getByText('معدّل ويُحفظ في السجل')).toBeInTheDocument();
  });
});
