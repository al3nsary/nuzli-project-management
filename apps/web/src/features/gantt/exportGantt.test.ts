/**
 * A9 QA: the PNG/PDF export. Arabic labels are drawn with direction="rtl"; in SVG the anchor
 * "start" of right-to-left text is its RIGHT edge, so every such label must use "start" (with
 * "end" the task names ran off the right edge of the image and bar labels ran over the bars).
 */
import { describe, expect, it } from 'vitest';
import { toDayNumber } from '@nuzli/scheduling';
import { ganttSvg, printGantt } from './exportGantt';
import { makeGantt } from './testData';

describe('Gantt export SVG', () => {
  it('anchors every right-to-left label at its right edge and keeps names inside the grid', () => {
    const data = makeGantt(2, 3);
    const from = toDayNumber('2026-10-25');
    const { svg, width } = ganttSvg({ data, fromDay: from, toDay: from + 40, dayWidth: 12, zoom: 'week', showHijri: false, digits: 'latn' as never });
    const rtl = [...svg.matchAll(/<text [^>]*direction="rtl"[^>]*>/g)].map((m) => m[0]);
    expect(rtl.length).toBeGreaterThan(data.tasks.length);
    for (const tag of rtl) {
      expect(tag).toMatch(/text-anchor="(start|middle)"/);
      const x = Number(/ x="([-\d.]+)"/.exec(tag)![1]);
      expect(x).toBeLessThanOrEqual(width);
    }
  });
});

describe('Gantt PDF (print) — A10 QA', () => {
  it('the printed SVG keeps LTR coordinates inside the dir="rtl" host, so "end"-anchored WBS numbers stay on the page', () => {
    const data = makeGantt(2, 3);
    const from = toDayNumber('2026-10-25');
    const print = window.print;
    let printed = 0;
    window.print = () => { printed++; };
    try {
      printGantt({ data, fromDay: from, toDay: from + 40, zoom: 'week', showHijri: false, digits: 'latn' as never });
      expect(printed).toBe(1);
      const host = document.getElementById('nz-gantt-print')!;
      expect(host.getAttribute('dir')).toBe('rtl');
      const css = [...document.head.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
      expect(css).toMatch(/#nz-gantt-print svg \{[^}]*direction: ltr/);
      // WBS numbers are the only "end"-anchored texts and carry no direction of their own.
      const wbs = [...host.querySelectorAll('text[text-anchor="end"]')];
      expect(wbs.length).toBeGreaterThan(0);
      for (const n of wbs) expect(n.getAttribute('direction')).toBeNull();
    } finally {
      window.print = print;
      window.dispatchEvent(new Event('afterprint'));
    }
    expect(document.getElementById('nz-gantt-print')).toBeNull();
  });
});
