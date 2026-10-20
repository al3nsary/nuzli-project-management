import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DirectionProvider, MantineProvider } from '@mantine/core';
import { ASSISTANT_MODULES, assistantGrants, can, type AssistantPermissions } from '@nuzli/shared';
import { AssistantGrid, AssistantPreview, assistantPreview } from './AssistantGrid';

let last: AssistantPermissions = {};

function Harness({ initial = {} }: { initial?: AssistantPermissions }) {
  const [value, setValue] = useState<AssistantPermissions>(initial);
  last = value;
  return (
    <DirectionProvider initialDirection="rtl">
      <MantineProvider>
        <AssistantGrid
          value={value}
          onChange={(v) => {
            last = v;
            setValue(v);
          }}
        />
        <AssistantPreview permissions={value} />
      </MantineProvider>
    </DirectionProvider>
  );
}

/** The assistant as `can()` sees them: no matrix role, only the grants of their modules. */
const assistantWith = (p: AssistantPermissions) => ({
  role: null,
  status: 'ACTIVE',
  roles: ['ASSISTANT'],
  grants: assistantGrants(p),
});

describe('AssistantGrid (A12 assistants)', () => {
  it('has one labelled radiogroup per module with لا شيء / اطّلاع / تعديل', () => {
    render(<Harness />);
    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(ASSISTANT_MODULES.length);
    const projects = screen.getByRole('radiogroup', { name: 'المشاريع' });
    expect(within(projects).getAllByRole('radio')).toHaveLength(3);
    expect(within(projects).getByRole('radio', { name: 'المشاريع: لا شيء' })).toBeChecked();
  });

  it('projects:view grants reading every project, not managing them', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'المشاريع: اطّلاع' }));
    expect(last).toEqual({ projects: 'view' });
    const user = assistantWith(last);
    expect(can(user, 'projects.readAll')).toBe(true);
    expect(can(user, 'projects.manage')).toBe(false);
    expect(can(user, 'projects.create')).toBe(false);
    // The live preview names the page.
    expect(screen.getByTestId('assistant-preview')).toHaveTextContent('كل المشاريع ومهامها');
  });

  it('edit includes view, and «لا شيء» removes the module', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'الفرق: تعديل' }));
    fireEvent.click(screen.getByRole('radio', { name: 'الميزانية والتكاليف: اطّلاع' }));
    expect(last).toEqual({ teams: 'edit', budget: 'view' });
    let user = assistantWith(last);
    expect(can(user, 'teams.readAll')).toBe(true);
    expect(can(user, 'teams.manageAll')).toBe(true);
    expect(can(user, 'budget.read')).toBe(true);
    expect(can(user, 'budget.manage')).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'الفرق: لا شيء' }));
    expect(last).toEqual({ budget: 'view' });
    user = assistantWith(last);
    expect(can(user, 'teams.readAll')).toBe(false);
  });

  it('locks «تعديل» on view-only modules (users, audit, settings) and never grants user editing', () => {
    render(<Harness />);
    for (const name of ['المستخدمون', 'سجل التدقيق', 'الإعدادات']) {
      expect(screen.getByRole('radio', { name: `${name}: تعديل` })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole('radio', { name: 'المستخدمون: اطّلاع' }));
    const user = assistantWith(last);
    expect(can(user, 'users.read')).toBe(true);
    expect(can(user, 'users.edit')).toBe(false);
    expect(can(user, 'users.manageRoles')).toBe(false);
    expect(can(user, 'nationalIds.readFull')).toBe(false);
  });

  it('previews pages and actions from the grants', () => {
    const p = assistantPreview({ tasks: 'edit', cards: 'edit' });
    expect(p.pages).toContain('كل المشاريع ومهامها');
    expect(p.pages).toContain('سجل الطباعة وقوالب البطاقات');
    expect(p.actions).toContain('إنشاء المهام وتعديلها وحذفها');
    expect(p.actions).toContain('طباعة البطاقات');
    expect(assistantPreview({})).toEqual({ pages: [], actions: [] });
  });
});
