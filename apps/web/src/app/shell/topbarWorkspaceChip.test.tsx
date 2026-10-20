/**
 * A12 verification (D2): on phones the compact top bar must say which workspace is open when there
 * are several (docs/a12-web.md «شارة مختصرة في الشريط العلوي على الجوال»); in single-workspace
 * mode it stays exactly as before (no chip).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../App';
import { DemoApi } from '../../api/demo/DemoApi';
import { useAuthStore } from '../../stores/auth';
import { TopBar } from './TopBar';

const trail = { title: 'المشاريع', crumbs: [], parent: null, group: null };
const A = { id: 'a', name: 'إدارة المشاريع', code: 'projects' };
const B = { id: 'b', name: 'قسم الصيانة', code: 'ws-2' };

function renderBar() {
  const api = new DemoApi({ dbName: `nuzli-chip-${Math.random()}` });
  render(
    <AppProviders api={api}>
      <MemoryRouter initialEntries={['/projects']}>
        <TopBar trail={trail} mobile />
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => useAuthStore.setState({ workspaces: [], activeWorkspace: null, singleWorkspace: true }));

describe('compact top bar — the workspace chip', () => {
  it('several workspaces: the active one is named in the bar', () => {
    useAuthStore.setState({ workspaces: [A, B] as never, activeWorkspace: B as never, singleWorkspace: false });
    renderBar();
    expect(screen.getByTestId('ws-chip')).toHaveTextContent('قسم الصيانة');
  });

  it('single-workspace mode: no chip (looks exactly as before)', () => {
    useAuthStore.setState({ workspaces: [A] as never, activeWorkspace: A as never, singleWorkspace: true });
    renderBar();
    expect(screen.queryByTestId('ws-chip')).toBeNull();
  });
});

describe('A12 verification D8 — the update banner clears the raised «تسجيل مخالفة»', () => {
  it('lifts the banner higher when the bar has a raised tab (26px above the bar)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '..', '..', 'theme', 'mobile.css'), 'utf8');
    const m = css.match(/html body:has\(\.nz-tbar \.nz-tb-raise\) \.nz-update \{[^}]*inset-block-end: calc\(var\(--tbar-h\) \+ var\(--safe-b\) \+ (\d+)px\)/);
    expect(m).not.toBeNull();
    const raise = Number(css.match(/\.nz-tb-raise \{[^}]*margin-top: -(\d+)px/)?.[1] ?? 0);
    expect(raise).toBeGreaterThan(0);
    expect(Number(m![1])).toBeGreaterThan(raise);
  });
});

describe('A12 verification D9 — touch tablets get 44px targets like phones', () => {
  it('a (min-width: 48em) and (pointer: coarse) block lifts buttons, fields, icon buttons, list links and map zoom to 44px', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '..', '..', 'theme', 'mobile.css'), 'utf8');
    const i = css.indexOf('@media (min-width: 48em) and (pointer: coarse) {');
    expect(i).toBeGreaterThan(0);
    const block = css.slice(i, css.indexOf('\n}\n', i));
    for (const sel of ['.mantine-Button-root', '.mantine-ActionIcon-root', '.nz-iconbtn', '.nz-pl-link', '.nz-chatbtn', '.nz-ps-tool']) expect(block).toContain(sel);
    expect(block).toContain('--input-height-sm: 44px');
    expect(css).toMatch(/\.leaflet-touch \.leaflet-bar a \{[^}]*width: 44px/);
  });
});
