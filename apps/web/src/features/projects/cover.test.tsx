/**
 * A12 round 2 — the project cover: with no image the generated cover shows the project's colour
 * and two Arabic-aware initials; the 16:9 crop geometry keeps the frame inside the picture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { projectColor } from '@nuzli/shared';
import { AppProviders } from '../../app/App';
import { DemoApi } from '../../api/demo/DemoApi';
import { ProjectCover, projectInitials } from './ProjectCover';
import { clampCover, coverRect, initialCover, panCover, zoomCover } from './coverCrop';

const ZWNJ = '‌';

describe('ProjectCover', () => {
  it('falls back to the generated cover: the project colour and the initials', async () => {
    const api = new DemoApi({ dbName: `nuzli-cover-${Math.random()}` });
    const id = '00000000-0000-4000-8000-f0000000abcd';
    render(
      <AppProviders api={api}>
        <ProjectCover project={{ id, name: 'مشروع صيانة الحديقة الشمالية', hasCover: false }} />
      </AppProviders>,
    );
    const cover = await screen.findByTestId('project-cover');
    expect(cover).toHaveAttribute('data-kind', 'generated');
    expect(cover.style.getPropertyValue('--cover')).toBe(projectColor(id));
    expect(cover).toHaveTextContent(`ص${ZWNJ}ح`);
    expect(cover).toHaveAccessibleName('غلاف مشروع مشروع صيانة الحديقة الشمالية');
    expect(cover.querySelector('img')).toBeNull();
  });

  it('uses the colour the API sends when there is one', async () => {
    const api = new DemoApi({ dbName: `nuzli-cover-${Math.random()}` });
    render(
      <AppProviders api={api}>
        <ProjectCover project={{ id: 'p1', name: 'الحديقة', color: '#0F9D58' }} />
      </AppProviders>,
    );
    const cover = await screen.findByTestId('project-cover');
    expect(cover.style.getPropertyValue('--cover')).toBe('#0F9D58');
    expect(cover).toHaveTextContent('ح');
  });

  it('initials skip filler words and the article', () => {
    expect(projectInitials('مشروع تأهيل الحديقة')).toBe(`ت${ZWNJ}ح`);
    expect(projectInitials('مشروع')).toBe('م');
    expect(projectInitials('  ')).toBe('؟');
  });

  it('owner QA A12: the first letters of the first two meaningful words, not the first and the last', () => {
    expect(projectInitials('تركيب نظام ري ذكي — مبنى الإدارة (تجريبي)')).toBe(`ت${ZWNJ}ن`);
    expect(projectInitials('(تجريبي) صيانة الحديقة')).toBe(`ص${ZWNJ}ح`);
    expect(projectInitials('تطوير في الحي الشمالي')).toBe(`ت${ZWNJ}ح`);
    expect(projectInitials('مشروع «الإنارة» و الطرق')).toBe(`إ${ZWNJ}ط`);
    expect(projectInitials('— ري —')).toBe('ر');
    expect(projectInitials('ال')).toBe('ا');
    expect(projectInitials('مشروع الأداء — 2000 مهمة (تجريبي)')).toBe(`أ${ZWNJ}م`);
    expect(projectInitials('2026')).toBe('2');
  });

  it('the generated cover never underlines its letters (the card is a link)', () => {
    const css = readFileSync(join(__dirname, 'cover.css'), 'utf8');
    expect(css).toMatch(/.nz-cover-initials {[^}]*text-decoration: none/);
    // A propagated underline cannot be cancelled by a child: the link around the cover drops it.
    expect(css).toContain('a:has(> .nz-cover),');
    expect(css).toMatch(/a:has\(> \.nz-cover\),[^{]*\{[^}]*text-decoration: none/);
  });
});

describe('16:9 cover crop', () => {
  it('fits the largest 16:9 rectangle, pans inside the picture and zooms around the centre', () => {
    const [w, h] = [4000, 3000];
    const s0 = initialCover(w, h);
    const r0 = coverRect(w, h, s0);
    expect(r0.w / r0.h).toBeCloseTo(16 / 9, 5);
    expect(r0.w).toBe(4000);
    // Dragging far never leaves the picture.
    const far = panCover(w, h, s0, 0, 100_000, 640);
    const rf = coverRect(w, h, far);
    expect(rf.y).toBeCloseTo(0, 5);
    const z = zoomCover(w, h, s0, 2);
    const rz = coverRect(w, h, z);
    expect(rz.w).toBeCloseTo(2000, 5);
    expect(rz.x + rz.w / 2).toBeCloseTo(2000, 5);
    expect(clampCover(w, h, { zoom: 99, cx: -5, cy: -5 }).zoom).toBe(4);
  });
});
