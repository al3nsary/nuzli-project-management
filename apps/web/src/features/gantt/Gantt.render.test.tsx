import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Gantt } from './Gantt';
import { makeGantt } from './testData';
import { OVERSCAN_ROWS, ROW_HEIGHT } from './geometry';

describe('Gantt virtualisation (brief §6.4: smooth at 2,000 tasks)', () => {
  const data = makeGantt(200, 9);
  const viewport = { width: 900, height: 600 };
  const visible = Math.ceil(viewport.height / ROW_HEIGHT) + 1;

  it('renders a bounded number of DOM rows and bars for 2,000 tasks', () => {
    const t0 = performance.now();
    const { container } = render(
      <Gantt
        data={data}
        zoom="week"
        showHijri
        digits="latn"
        editable
        gridMode="full"
        viewport={viewport}
        onOpenTask={() => {}}
        onCommit={() => {}}
        onLink={() => {}}
        onLinkRefused={() => {}}
      />,
    );
    const elapsed = performance.now() - t0;
    const rows = container.querySelectorAll('[data-row]').length;
    const bars = container.querySelectorAll('[data-bar]').length;
    expect(data.tasks).toHaveLength(2000);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(visible + 2 * OVERSCAN_ROWS);
    expect(bars).toBeLessThanOrEqual(visible + 2 * OVERSCAN_ROWS);
    // The scroll area still represents all 2,000 rows.
    const body = container.querySelector('[data-testid=gantt-body] > div') as HTMLElement;
    expect(body.style.height).toBe(`${2000 * ROW_HEIGHT}px`);
    console.info(`gantt first render (jsdom), 2,000 tasks: ${elapsed.toFixed(0)} ms, ${rows} DOM rows`);
  });

  it('scrolling moves the window and keeps it bounded', async () => {
    const { container } = render(
      <Gantt data={data} zoom="month" showHijri={false} digits="latn" editable={false} gridMode="narrow" viewport={viewport} onOpenTask={() => {}} onCommit={() => {}} onLink={() => {}} onLinkRefused={() => {}} />,
    );
    const body = container.querySelector('[data-testid=gantt-body]') as HTMLElement;
    body.scrollTop = 1000 * ROW_HEIGHT;
    fireEvent.scroll(body);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
    const indices = [...container.querySelectorAll('[data-row]')].map((r) => Number(r.getAttribute('data-row-index')));
    expect(Math.min(...indices)).toBeGreaterThanOrEqual(1000 - OVERSCAN_ROWS - 1);
    expect(indices.length).toBeLessThanOrEqual(visible + 2 * OVERSCAN_ROWS);
  });

  it('keyboard: ↓ moves focus, Enter opens, Alt+← shifts the task later (RTL)', () => {
    const open = vi.fn();
    const commit = vi.fn();
    const small = makeGantt(1, 3);
    const { container } = render(
      <Gantt data={small} zoom="day" showHijri={false} digits="latn" editable gridMode="full" viewport={viewport} onOpenTask={open} onCommit={commit} onLink={() => {}} onLinkRefused={() => {}} />,
    );
    const grid = container.querySelector('[role=treegrid]') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(open).toHaveBeenCalledWith('t1');
    fireEvent.keyDown(grid, { key: 'ArrowLeft', altKey: true });
    expect(commit).toHaveBeenCalledTimes(1);
    const changes = commit.mock.calls[0]![0] as { id: string; startDate: string }[];
    const t1 = small.tasks.find((t) => t.id === 't1')!;
    expect(changes.find((c) => c.id === 't1')!.startDate > t1.startDate).toBe(true);
  });
});

describe('task name click vs double-click (A9 QA)', () => {
  const small = makeGantt(1, 3);
  const leaf = small.tasks.find((x) => x.parentId)!;
  const setup = () => {
    const open = vi.fn();
    const rename = vi.fn();
    const utils = render(
      <Gantt data={small} zoom="week" showHijri={false} digits="latn" editable gridMode="full" viewport={{ width: 900, height: 600 }} onOpenTask={open} onRename={rename} onCommit={() => {}} onLink={() => {}} onLinkRefused={() => {}} />,
    );
    const name = [...utils.container.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === leaf.name) as HTMLElement;
    return { ...utils, open, rename, name };
  };

  it('a single click opens the task after the double-click window', async () => {
    vi.useFakeTimers();
    const { open, name } = setup();
    fireEvent.click(name, { detail: 1 });
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(open).toHaveBeenCalledWith(leaf.id);
    vi.useRealTimers();
  });

  it('a double-click renames instead of opening', () => {
    vi.useFakeTimers();
    const { open, rename, name, container } = setup();
    fireEvent.click(name, { detail: 1 });
    fireEvent.click(name, { detail: 2 });
    fireEvent.doubleClick(name);
    vi.advanceTimersByTime(400);
    expect(open).not.toHaveBeenCalled();
    const input = container.querySelector('input[aria-label]') as HTMLInputElement;
    expect(input.value).toBe(leaf.name);
    fireEvent.change(input, { target: { value: 'اسم جديد' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith(leaf.id, 'اسم جديد');
    vi.useRealTimers();
  });
});

describe('timeline labels read right-to-left (A10 QA)', () => {
  it('every SVG text with Arabic in the timeline is direction="rtl" and anchored at its right edge', () => {
    const data = makeGantt(6, 3);
    const { container } = render(
      <Gantt
        data={data}
        zoom="week"
        showHijri={false}
        digits="latn"
        editable
        gridMode="full"
        viewport={{ width: 900, height: 600 }}
        onOpenTask={() => {}}
        onCommit={() => {}}
        onLink={() => {}}
        onLinkRefused={() => {}}
      />,
    );
    const texts = [...container.querySelectorAll('svg text')].filter((n) => /[؀-ۿ]/.test(n.textContent ?? ''));
    expect(texts.length).toBeGreaterThan(3);
    for (const n of texts) {
      // «29 سبتمبر – 12 أكتوبر» and «متأخرة 5 أيام» were laid out LTR inside the dir="ltr" timeline.
      expect(n.getAttribute('direction')).toBe('rtl');
      expect(n.getAttribute('text-anchor')).not.toBe('end');
    }
  });
});
