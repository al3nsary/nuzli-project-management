import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { nationalIdCheckDigit, type CardData, type CardLayoutKey, type CardOrientation } from '@nuzli/shared';
import {
  BUILTIN_CARD_SIZES,
  CARD_BASE_CSS,
  CalibrationCard,
  ClassicHorizontal,
  CompactLabel,
  DEFAULT_CARD_SIZE,
  PrintSheet,
  VerticalBadge,
  WorkCard,
  assertSafeQrValue,
  buildCardModel,
  cardInitials,
  waitForCardImages,
  fitFontPt,
  isNationalIdLike,
  makeQrDataUrl,
  printCss,
  resolveCardDimensions,
  withQrDataUrls,
  type CardTemplateConfigInput,
  type CardTemplateLike,
} from './index';

const NATIONAL_ID = `123456789${nationalIdCheckDigit('123456789')}`;
const MEMBER_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const data: CardData = {
  fullName: 'محمد بن عبدالرحمن القحطاني',
  jobTitle: 'مراقب ميداني',
  nationalId: NATIONAL_ID,
  department: 'العمليات',
  teamName: 'فريق الصقور',
  teamColor: '#C2410C',
  qrValue: MEMBER_UUID,
  validUntil: '2027-03-31',
};

const LONG_NAME = 'عبدالرحمن بن عبدالعزيز بن محمد بن عبدالله بن سلطان آل عبدالكريم القحطاني الشمري';

const LAYOUT_KEYS: CardLayoutKey[] = ['CLASSIC_HORIZONTAL', 'VERTICAL_BADGE', 'COMPACT_LABEL'];
const ORIENTATIONS: CardOrientation[] = ['LANDSCAPE', 'PORTRAIT'];

function template(
  layoutKey: CardLayoutKey = 'CLASSIC_HORIZONTAL',
  config: CardTemplateConfigInput = {},
  size: { widthMm: number; heightMm: number } = DEFAULT_CARD_SIZE,
  orientation: CardOrientation = 'LANDSCAPE',
): CardTemplateLike {
  return { size, orientation, layoutKey, config };
}

const render = (el: JSX.Element) => renderToStaticMarkup(el);

describe('sizes', () => {
  it('has the six presets of §8.3 with CR80 as the only default', () => {
    expect(BUILTIN_CARD_SIZES.map((s) => [s.widthMm, s.heightMm])).toEqual([
      [85.6, 54],
      [90, 40],
      [101.6, 50.8],
      [76.2, 50.8],
      [101.6, 76.2],
      [57, 32],
    ]);
    expect(BUILTIN_CARD_SIZES.filter((s) => s.isDefault).map((s) => s.key)).toEqual(['CR80']);
    expect(DEFAULT_CARD_SIZE.key).toBe('CR80');
    for (const s of BUILTIN_CARD_SIZES) expect(s.name).toMatch(/[؀-ۿ]/);
  });

  it('swaps for portrait and keeps landscape wide', () => {
    expect(resolveCardDimensions({ widthMm: 85.6, heightMm: 54 }, 'LANDSCAPE')).toEqual({ widthMm: 85.6, heightMm: 54 });
    expect(resolveCardDimensions({ widthMm: 85.6, heightMm: 54 }, 'PORTRAIT')).toEqual({ widthMm: 54, heightMm: 85.6 });
    expect(resolveCardDimensions({ widthMm: 40, heightMm: 90 }, 'LANDSCAPE')).toEqual({ widthMm: 90, heightMm: 40 });
  });

  it('a portrait template renders a tall card', () => {
    const html = render(<WorkCard template={template('VERTICAL_BADGE', {}, DEFAULT_CARD_SIZE, 'PORTRAIT')} data={data} />);
    expect(html).toContain('width:54mm;height:85.6mm');
  });
});

describe('layouts', () => {
  for (const layoutKey of LAYOUT_KEYS) {
    for (const size of BUILTIN_CARD_SIZES) {
      for (const orientation of ORIENTATIONS) {
        it(`${layoutKey} renders at ${size.key} ${orientation}`, () => {
          const t = template(
            layoutKey,
            { fields: { photo: true, validUntil: true } },
            size,
            orientation,
          );
          const html = render(
            <WorkCard template={t} data={{ ...data, fullName: LONG_NAME }} logoUrl="/logo.png" photoUrl="/p.jpg" />,
          );
          const { widthMm, heightMm } = resolveCardDimensions(size, orientation);
          expect(html).toContain(`width:${widthMm}mm;height:${heightMm}mm`);
          expect(html).toContain('dir="rtl"');
          expect(html).toContain('IBM Plex Sans Arabic');
          expect(html).not.toMatch(/\d(px)\b/);
          expect(html).toContain('فريق الصقور');
        });
      }
    }
  }

  it('exports the three layout components directly', () => {
    const model = buildCardModel(template(), data);
    for (const Layout of [ClassicHorizontal, VerticalBadge, CompactLabel]) {
      expect(render(<Layout model={model} />)).toContain('nz-card');
    }
  });

  it('shrinks long names at 57×32 and clamps them to the available lines', () => {
    const small = BUILTIN_CARD_SIZES.find((s) => s.key === 'IN225_IN125')!;
    const html = render(<WorkCard template={template('COMPACT_LABEL', {}, small)} data={{ ...data, fullName: LONG_NAME }} />);
    const size = Number(/class="nz-name" style="font-size:([\d.]+)pt/.exec(html)?.[1]);
    expect(size).toBeLessThan(11);
    expect(size).toBeGreaterThanOrEqual(5);
    expect(html).toMatch(/-webkit-line-clamp:\d/);
    expect(fitFontPt('قصير', { basePt: 11, minPt: 6, widthMm: 40 })).toBe(11);
  });
});

describe('fields', () => {
  it('masks the national ID by default and shows it in full when the template says so', () => {
    const masked = render(<WorkCard template={template()} data={data} />);
    expect(masked).toContain('1•••••••');
    expect(masked).not.toContain(NATIONAL_ID);
    const full = render(<WorkCard template={template('CLASSIC_HORIZONTAL', { maskNationalId: false })} data={data} />);
    expect(full).toContain(NATIONAL_ID);
  });

  it('does not render hidden fields', () => {
    const t = template('CLASSIC_HORIZONTAL', {
      fields: { jobTitle: false, nationalId: false, department: false, qr: false, logo: false, validUntil: false },
    });
    const html = render(<WorkCard template={t} data={data} logoUrl="/logo.png" />);
    expect(html).not.toContain('مراقب ميداني');
    expect(html).not.toContain('رقم الهوية');
    expect(html).not.toContain('1•••••••');
    expect(html).not.toContain('العمليات');
    expect(html).not.toContain('nz-qr');
    expect(html).not.toContain('/logo.png');
    expect(html).not.toContain('صالحة حتى');
    expect(html).toContain(data.fullName);
  });

  it('never shows the team colour without the team name', () => {
    const shown = render(<WorkCard template={template()} data={data} />);
    expect(shown).toContain('nz-band');
    expect(shown).toContain('فريق الصقور');
    const hidden = render(<WorkCard template={template('CLASSIC_HORIZONTAL', { fields: { teamName: false } })} data={data} />);
    expect(hidden).not.toContain('nz-band');
    expect(hidden).not.toContain('#C2410C');
  });

  it('draws the vest band on the chosen edge with two reflective lines', () => {
    for (const strip of ['start', 'top', 'bottom'] as const) {
      const html = render(<WorkCard template={template('CLASSIC_HORIZONTAL', { accentStrip: strip })} data={data} />);
      expect(html).toContain(`nz-band--${strip}`);
      expect(html.match(/rgba\(255, 255, 255, 0\.3\)/g)?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('honours logo position, colours, font sizes and validity date', () => {
    const html = render(
      <WorkCard
        template={template('VERTICAL_BADGE', {
          logoPosition: 'center',
          background: '#FAFAF0',
          textColor: '#102030',
          fontSizes: { name: 14, body: 8 },
          fields: { validUntil: true },
        })}
        data={data}
        logoUrl="/logo.png"
      />,
    );
    expect(html).toContain('data-logo-position="center"');
    expect(html).toContain('background:#FAFAF0');
    expect(html).toContain('color:#102030');
    expect(html).toContain('صالحة حتى');
    expect(html).toContain('2027');
  });

  it('uses a pre-rendered QR when given, otherwise a vector QR of the UUID', () => {
    const vector = render(<WorkCard template={template()} data={data} />);
    expect(vector).toMatch(/<svg class="nz-qr"/);
    const png = render(<WorkCard template={template()} data={data} qrDataUrl="data:image/png;base64,AAAA" />);
    expect(png).toContain('src="data:image/png;base64,AAAA"');
  });

  it('leaves the QR out when the value looks like a national ID', () => {
    const html = render(<WorkCard template={template()} data={{ ...data, qrValue: NATIONAL_ID }} />);
    expect(html).not.toContain('nz-qr');
  });
});

describe('QR helper', () => {
  it('encodes the internal UUID as a PNG data URL', async () => {
    const url = await makeQrDataUrl(MEMBER_UUID);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects national-ID-like values', async () => {
    await expect(makeQrDataUrl(NATIONAL_ID)).rejects.toThrow(/national ID/);
    await expect(makeQrDataUrl('٢٠٣٤٥٦٧٨٩١')).rejects.toThrow(/national ID/);
    await expect(makeQrDataUrl('1234 567 890')).rejects.toThrow(/national ID/);
    expect(() => assertSafeQrValue('member:1098765432')).toThrow();
    expect(() => assertSafeQrValue('')).toThrow();
    expect(isNationalIdLike(MEMBER_UUID)).toBe(false);
    expect(isNationalIdLike('12345678-1234-1234-1234-123456789012')).toBe(false);
  });

  it('withQrDataUrls fills PNGs only for safe values', async () => {
    const [a, b] = await withQrDataUrls([{ data }, { data: { ...data, qrValue: NATIONAL_ID } }]);
    expect(a?.qrDataUrl).toMatch(/^data:image\/png/);
    expect(b?.qrDataUrl).toBeUndefined();
  });
});

describe('print CSS and sheet', () => {
  it('printCss sets the exact @page size, zero margins and one card per page', () => {
    const css = printCss(85.6, 54);
    expect(css).toContain('@page { size: 85.6mm 54mm; margin: 0; }');
    expect(css).toContain('html, body { margin: 0;');
    expect(css).toContain('.nz-card { width: 85.6mm; height: 54mm; page-break-after: always; break-after: page;');
    expect(css).toContain('overflow: hidden');
    expect(css).toContain('-webkit-print-color-adjust: exact; print-color-adjust: exact;');
    expect(printCss(90, 40)).toContain('size: 90mm 40mm');
    expect(() => printCss(0, 40)).toThrow();
  });

  it('PrintSheet renders one card per item with the page CSS of the oriented size', () => {
    const t = template('VERTICAL_BADGE', {}, DEFAULT_CARD_SIZE, 'PORTRAIT');
    const html = render(<PrintSheet template={t} cards={[{ data }, { data: { ...data, fullName: 'سارة الغامدي' } }]} />);
    expect(html.match(/class="nz-card /g)?.length).toBe(2);
    expect(html).toContain('size: 54mm 85.6mm');
    expect(html).toContain('سارة الغامدي');
  });

  it('src/print.css matches CARD_BASE_CSS and uses no px', () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'print.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\r\n/g, '\n')
      .trim();
    expect(file).toBe(CARD_BASE_CSS);
    expect(file).not.toMatch(/\dpx/);
    expect(file).toMatch(/\.nz-card \{/);
  });
});

describe('calibration card', () => {
  it('prints the size, edge border, rulers, crosshair and samples', () => {
    const html = render(<CalibrationCard size={{ widthMm: 90, heightMm: 40 }} />);
    expect(html).toContain('size: 90mm 40mm');
    expect(html).toContain('90 × 40');
    expect(html).toContain('data-role="edge"');
    expect(html).toContain('data-role="crosshair"');
    expect(html.match(/data-role="tick-x"/g)?.length).toBe(17);
    expect(html.match(/data-role="tick-y"/g)?.length).toBe(7);
    expect(html).toContain('اختبار المعايرة');
    expect(html).toContain('Nuzli calibration');
    expect(html).not.toMatch(/\dpx/);
  });
});

describe('photo area (owner request A8)', () => {
  const photoBox = (html: string) => {
    const m = /data-photo-mm="([\d.]+)x([\d.]+)"/.exec(html);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  };

  it('built-in defaults reserve the photo area', () => {
    expect(buildCardModel(template(), data).showPhoto).toBe(true);
  });

  it('shows the photo (object-fit: cover) in a thin #C5CAE9 frame with a 1 mm radius', () => {
    const html = render(<WorkCard template={template()} data={data} photoUrl="/p.jpg" />);
    expect(html).toContain('data-photo="image"');
    expect(html).toMatch(/<img class="nz-photo" src="\/p.jpg"/);
    expect(html).toContain('border:0.25mm solid #C5CAE9');
    expect(html).toContain('border-radius:1mm');
    expect(CARD_BASE_CSS).toMatch(/\.nz-photo \{[^}]*object-fit: cover/);
  });

  it('without a photo: initials of the first and last name on #E8EAF6 in #303F9F, with a silhouette', () => {
    const html = render(<WorkCard template={template()} data={data} />);
    expect(html).toContain('data-photo="placeholder"');
    expect(html).toContain('background:#E8EAF6');
    expect(html).toContain('color:#303F9F');
    expect(html).toContain('nz-photo-silhouette');
    expect(html).toContain('>م‌ق</span>');
    expect(html).not.toContain('<img class="nz-photo"');
  });

  it('cardInitials skips particles and the article', () => {
    expect(cardInitials('محمد بن عبدالرحمن القحطاني')).toBe('م‌ق');
    expect(cardInitials('سارة الغامدي')).toBe('س‌غ');
    expect(cardInitials('عبدالله آل سعود')).toBe('ع‌س');
    expect(cardInitials('نورة')).toBe('ن');
    expect(cardInitials('  ')).toBe('');
    expect(cardInitials('john smith')).toBe('J‌S');
  });

  it('fields.photo=false leaves the photo area out, even with a URL', () => {
    for (const layoutKey of LAYOUT_KEYS) {
      const html = render(<WorkCard template={template(layoutKey, { fields: { photo: false } })} data={data} photoUrl="/p.jpg" />);
      expect(html).not.toContain('nz-photo-frame');
      expect(html).not.toContain('/p.jpg');
    }
  });

  it('sizes per layout: classic ~22×29 at CR80, badge top-centre ≥ 22 mm wide, compact ~14×18 at 90×40 and 57×32', () => {
    const classic = photoBox(render(<WorkCard template={template()} data={data} logoUrl="/l.png" />))!;
    expect(classic.w).toBeGreaterThanOrEqual(21);
    expect(classic.w).toBeLessThanOrEqual(23);
    const badge = photoBox(render(<WorkCard template={template('VERTICAL_BADGE', {}, DEFAULT_CARD_SIZE, 'PORTRAIT')} data={data} logoUrl="/l.png" />))!;
    expect(badge.w).toBeGreaterThanOrEqual(22);
    expect(badge.h).toBeLessThanOrEqual(34.01);
    for (const key of ['W90_H40', 'IN225_IN125'] as const) {
      const size = BUILTIN_CARD_SIZES.find((s) => s.key === key)!;
      const box = photoBox(render(<WorkCard template={template('COMPACT_LABEL', {}, size)} data={data} />))!;
      expect(box.h).toBeCloseTo(18, 1);
      expect(box.w).toBeCloseTo(13.5, 1);
    }
  });

  it('compact labels below the minimum height leave the photo out', () => {
    const html = render(<WorkCard template={template('COMPACT_LABEL', {}, { widthMm: 60, heightMm: 14 })} data={data} />);
    expect(html).not.toContain('nz-photo-frame');
  });

  for (const layoutKey of LAYOUT_KEYS) {
    for (const size of BUILTIN_CARD_SIZES) {
      for (const orientation of ORIENTATIONS) {
        it(`${layoutKey} ${size.key} ${orientation}: the 3:4 photo area fits inside the card, in mm`, () => {
          const t = template(layoutKey, { fields: { validUntil: true } }, size, orientation);
          const html = render(<WorkCard template={t} data={{ ...data, fullName: LONG_NAME }} logoUrl="/logo.png" />);
          expect(html).not.toMatch(/\d(px)\b/);
          const box = photoBox(html);
          const { widthMm, heightMm } = resolveCardDimensions(size, orientation);
          if (!box) {
            // Only media too short (landscape badge) or too narrow (portrait labels) leave it out.
            expect((layoutKey === 'VERTICAL_BADGE' && orientation === 'LANDSCAPE') || widthMm < 45).toBe(true);
            return;
          }
          expect(box.h / box.w).toBeCloseTo(4 / 3, 2);
          expect(box.w).toBeLessThan(widthMm * 0.6);
          expect(box.h).toBeLessThan(heightMm * 0.9);
          expect(html).toContain(LONG_NAME.slice(0, 10));
        });
      }
    }
  }
});

describe('waitForCardImages', () => {
  function sheet(count: number) {
    const root = document.createElement('div');
    root.innerHTML = `<div class="nz-card">${'<img src="/x.jpg">'.repeat(count)}</div>`;
    const imgs = Array.from(root.querySelectorAll('img'));
    for (const img of imgs) Object.defineProperty(img, 'complete', { value: false, configurable: true });
    return { root, imgs };
  }

  it('resolves when every card image has loaded or failed', async () => {
    const { root, imgs } = sheet(2);
    const p = waitForCardImages(root, 5000);
    imgs[0]!.dispatchEvent(new Event('load'));
    imgs[1]!.dispatchEvent(new Event('error'));
    await expect(p).resolves.toEqual({ total: 2, loaded: 1, failed: 1, timedOut: false });
  });

  it('resolves after the timeout when an image never settles; no images → at once', async () => {
    const { root } = sheet(1);
    await expect(waitForCardImages(root, 20)).resolves.toMatchObject({ total: 1, timedOut: true });
    await expect(waitForCardImages(document.createElement('div'))).resolves.toEqual({ total: 0, loaded: 0, failed: 0, timedOut: false });
  });
});

describe('worker foreman marker (owner request A10)', () => {
  const foreman = { ...data, isForeman: true } as CardData;
  for (const layoutKey of LAYOUT_KEYS) {
    for (const size of BUILTIN_CARD_SIZES) {
      for (const orientation of ORIENTATIONS) {
        it(`${layoutKey} ${size.key} ${orientation}: «مشرف عمّال» ribbon with a helmet, in mm, never dropped`, () => {
          const html = render(<WorkCard template={template(layoutKey, {}, size, orientation)} data={foreman} />);
          expect(html).toContain('data-foreman="true"');
          expect(html).toContain('مشرف عمّال');
          expect(html).toContain('class="nz-helmet"');
          expect(html).toContain('#303F9F');
          expect(html).not.toMatch(/\d(px)\b/);
          // The ribbon comes right after the name.
          expect(html.indexOf('data-field="role"')).toBeGreaterThan(html.indexOf('class="nz-name"'));
          expect(html).not.toMatch(/data-dropped="[^"]*role/);
        });
      }
    }
  }

  it('reads `roleLabel: «مشرف عمّال»` too, and prints nothing for other members or other labels', () => {
    expect(buildCardModel(template(), { ...data, roleLabel: 'مشرف عمّال' }).role).toEqual({ label: 'مشرف عمّال', foreman: true });
    expect(buildCardModel(template(), data).role).toBeNull();
    expect(buildCardModel(template(), { ...data, roleLabel: 'مشرف' }).role).toBeNull();
    const plain = render(<WorkCard template={template()} data={data} />);
    expect(plain).not.toContain('data-foreman');
    expect(plain).not.toContain('مشرف عمّال');
  });

  it('frames a foreman photo in indigo; the text label is always there (not colour only)', () => {
    const html = render(<WorkCard template={template()} data={{ ...data, isForeman: true } as CardData} />);
    expect(html).toMatch(/nz-photo-frame[^>]*border:0\.5mm solid #303F9F/);
    expect(html).toMatch(/nz-role-text">مشرف عمّال</);
  });
});
