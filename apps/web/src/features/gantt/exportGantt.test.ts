/**
 * A9 QA: the PNG/PDF export. Arabic labels are drawn with direction="rtl"; in SVG the anchor
 * "start" of right-to-left text is its RIGHT edge, so every such label must use "start" (with
 * "end" the task names ran off the right edge of the image and bar labels ran over the bars).
 */
import { describe, expect, it } from 'vitest';
import { toDayNumber } from '@nuzli/scheduling';
import { ganttSvg } from './exportGantt';
import { makeGantt } from './testData';

describe('Gantt export SVG', () => {
  it('anchors every right-to-left label at its right edge and keeps names inside the grid', () => {
    const data = makeGantt(2, 3);
    const from = toDayNumber('2026-10-25');
    const { svg, width } = ganttSvg({ data, fromDay: from, toDay: from + 40, dayWidth: 12, zoom: 'week', showHijri: false, digits: 'latn' as never });
    const rtl = [...svg.matchAll(/<text [^>]*direction="rtl"[^>]*>/g)].map((m) => m[0]);
    expect(rtl.length).toBeGreaterThan(data.tasks.length);
    for (const tag of rtl) {
      expect(tag).toContain('text-anchor="start"');
      const x = Number(/ x="([-\d.]+)"/.exec(tag)![1]);
      expect(x).toBeLessThanOrEqual(width);
    }
  });
});
