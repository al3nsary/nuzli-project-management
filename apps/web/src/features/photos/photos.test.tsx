/**
 * Owner request A8 on the client: crop geometry, the 600×600 JPEG output (canvas mocked —
 * jsdom has none), the avatar (initials vs photo), photo URL freshness, card previews with
 * photos, and the print view waiting for fonts and card images before `window.print()`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MantineProvider, DirectionProvider } from '@mantine/core';
import { RouterProvider } from 'react-router-dom';
import { cardTemplateConfigSchema, type CardTemplateDto } from '@nuzli/shared';
import { blobToArrayBuffer, hasExif } from '../../lib/bytes';
import {
  PHOTO_OUTPUT_PX,
  clampCrop,
  cropRect,
  initialCrop,
  maxZoom,
  panBy,
  renderCrop,
  validateDimensions,
  validateSource,
  zoomTo,
} from './crop';
import { canChangeMemberPhoto, canChangeUserPhoto } from './access';
import { photoStaleTime, PHOTO_URL_MARGIN_MS } from '../../api/photoQueries';
import { UserAvatar } from '../../components/UserAvatar';
import { CardEditor, type EditableCard } from '../../pages/cards/CardEditor';

const waitForCardImages = vi.hoisted(() => vi.fn());
vi.mock('@nuzli/ui-print', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nuzli/ui-print')>();
  return { ...actual, waitForCardImages };
});

afterEach(() => {
  waitForCardImages.mockReset();
  vi.restoreAllMocks();
});

describe('crop geometry', () => {
  it('starts with the largest centred square', () => {
    const s = initialCrop(1200, 800);
    expect(cropRect(1200, 800, s)).toEqual({ x: 200, y: 0, side: 800 });
  });

  it('never zooms the crop below 300 source pixels (and at most ×4)', () => {
    expect(maxZoom(600, 900)).toBe(2);
    expect(maxZoom(300, 300)).toBe(1);
    expect(maxZoom(4000, 3000)).toBe(4);
    expect(zoomTo(600, 600, initialCrop(600, 600), 9).zoom).toBe(2);
    expect(zoomTo(600, 600, initialCrop(600, 600), 0.2).zoom).toBe(1);
  });

  it('pans with the pointer (physical pixels, no direction sign) and stays inside the image', () => {
    const s = zoomTo(1200, 1200, initialCrop(1200, 1200), 2); // side 600, centre 600
    // Dragging the picture 140 px right on a 280 px view shows what is to its left.
    const moved = panBy(1200, 1200, s, 140, 0, 280);
    expect(moved.cx).toBe(300);
    expect(cropRect(1200, 1200, moved).x).toBe(0);
    const far = panBy(1200, 1200, s, -10_000, -10_000, 280);
    expect(cropRect(1200, 1200, far)).toEqual({ x: 600, y: 600, side: 600 });
    expect(clampCrop(800, 800, { zoom: 1, cx: -5, cy: 9999 })).toEqual({ zoom: 1, cx: 400, cy: 400 });
  });

  it('validates the type, the size and the dimensions with Arabic messages', () => {
    expect(validateSource({ type: 'image/svg+xml', size: 10 })).toBe('photo.err.type');
    expect(validateSource({ type: 'image/heic', size: 10 })).toBe('photo.err.type');
    expect(validateSource({ type: 'image/png', size: 16 * 1024 * 1024 })).toBe('photo.err.size');
    expect(validateSource({ type: 'image/webp', size: 1000 })).toBeNull();
    expect(validateDimensions(299, 1000)).toBe('photo.err.small');
    expect(validateDimensions(300, 300)).toBeNull();
  });
});

describe('crop output', () => {
  it('draws the crop on a 600×600 canvas and returns a JPEG without EXIF', async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: vi.fn(), drawImage, fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: 'low' }),
      // A JPEG that still carries an EXIF APP1 segment: the output must not.
      toBlob: (cb: (b: Blob) => void, type: string, quality: number) => {
        expect(type).toBe('image/jpeg');
        expect(quality).toBeCloseTo(0.85);
        const exif = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
        cb(new Blob([new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9])], { type }));
      },
    };
    const doc = { createElement: () => canvas } as unknown as Document;
    const image = { source: {} as CanvasImageSource, width: 1200, height: 800 };
    const blob = await renderCrop(image, initialCrop(1200, 800), PHOTO_OUTPUT_PX, doc);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(600);
    expect(drawImage).toHaveBeenCalledWith(image.source, 200, 0, 800, 800, 0, 0, 600, 600);
    expect(blob.type).toBe('image/jpeg');
    expect(hasExif(new Uint8Array(await blobToArrayBuffer(blob)))).toBe(false);
  });
});

describe('signed URL hygiene', () => {
  it('goes stale a minute before the URL expires', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    const data = { url: 'u', expiresAt: '2026-10-12T10:05:00Z' };
    expect(photoStaleTime(data, now)).toBe(5 * 60_000 - PHOTO_URL_MARGIN_MS);
    expect(photoStaleTime({ ...data, expiresAt: '2026-10-12T10:00:30Z' }, now)).toBe(0);
  });
});

describe('who sees the photo actions (client side)', () => {
  const sup = { id: 's1', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const };
  const teams = [
    { id: 't1', status: 'ACTIVE', supervisor: { id: 's1' } },
    { id: 't2', status: 'ACTIVE', supervisor: { id: 's2' } },
  ];
  it('admin and the leading supervisor only', () => {
    expect(canChangeMemberPhoto({ id: 'a', role: 'ADMIN', status: 'ACTIVE' }, { team: null }, [])).toBe(true);
    expect(canChangeMemberPhoto(sup, { team: { id: 't1' } }, teams)).toBe(true);
    expect(canChangeMemberPhoto(sup, { team: { id: 't2' } }, teams)).toBe(false);
    expect(canChangeMemberPhoto(sup, { team: null }, teams)).toBe(false);
    expect(canChangeMemberPhoto({ id: 'm', role: 'MONITOR', status: 'ACTIVE' }, { team: { id: 't1' } }, teams)).toBe(false);
    expect(canChangeUserPhoto(sup, 's1')).toBe(true);
    expect(canChangeUserPhoto(sup, 's2')).toBe(false);
  });
});

const wrap = (ui: JSX.Element) => (
  <DirectionProvider initialDirection="rtl">
    <MantineProvider>{ui}</MantineProvider>
  </DirectionProvider>
);

describe('UserAvatar', () => {
  it('shows initials without a photo', () => {
    const { container } = render(wrap(<UserAvatar name="نورة بنت سعد العتيبي" />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.nz-avatar')!.textContent).toBe('ن‌ع');
  });

  it('shows the photo with no referrer, and falls back to initials when it fails', () => {
    const { container } = render(wrap(<UserAvatar name="فهد الدوسري" photoUrl="blob:photo" />));
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'blob:photo');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.nz-avatar')!.textContent).toBe('ف‌د');
  });
});

describe('card preview with photos', () => {
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
  const card = (key: string, extra: Partial<EditableCard>): EditableCard => {
    const data = { fullName: 'أحمد محمد المالكي', teamName: 'فريق', teamColor: '#14593F', qrValue: '00000000-0000-4000-8000-b00000000001' };
    return { key, original: data, data, selected: true, saveBack: false, ...extra };
  };

  it('passes photoUrl to the card for member and supervisor subjects; initials otherwise', () => {
    const cards = [
      card('m:1', { memberId: 'm1', photoUrl: 'blob:member' }),
      card('u:1', { userId: 'u1', photoUrl: 'blob:supervisor' }),
      card('m:2', { memberId: 'm2', photoUrl: null }),
    ];
    const { container } = render(
      wrap(
        <CardEditor template={TEMPLATE} logoUrl={null} cards={cards} activeKey={null} onActivate={() => undefined} onChange={() => undefined} />,
      ),
    );
    const photos = Array.from(container.querySelectorAll('.nz-card img.nz-photo')).map((i) => i.getAttribute('src'));
    expect(photos).toEqual(['blob:member', 'blob:supervisor']);
    expect(container.querySelectorAll('.nz-card').length).toBe(3);
  });
});

describe('print view', () => {
  it('waits for the fonts, then for the card images, before window.print()', async () => {
    const { DemoApi } = await import('../../api/demo/DemoApi');
    const { DEMO_PASSWORD } = await import('../../api/demo/constants');
    const { AppProviders } = await import('../../app/App');
    const { createTestRouter } = await import('../../app/router');
    const { useAuthStore } = await import('../../stores/auth');
    const { putPrintRun } = await import('../cards/printRun');

    const api = new DemoApi({ dbName: `nuzli-print-${Math.random()}` });
    const s = await api.auth.login({ identifier: 'admin1@demo.nuzli.example', password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);
    const tpl = (await api.cards.templates()).find((x) => x.isDefault)!;
    const preview = await api.cards.preview({
      templateId: tpl.id,
      teamIds: ['00000000-0000-4000-8000-a00000000001'],
      includeSupervisors: true,
    });
    const batch = await api.cards.createBatch({
      idempotencyKey: crypto.randomUUID(),
      templateId: tpl.id,
      items: preview.subjects.slice(0, 2).map((x) => ({ memberId: x.memberId ?? null, userId: x.userId ?? null, data: x.data })),
    });
    putPrintRun(batch.id, batch.cards);

    let fontsDone!: () => void;
    const order: string[] = [];
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        load: () => Promise.resolve([]),
        ready: new Promise<void>((r) => {
          fontsDone = () => {
            order.push('fonts');
            r();
          };
        }),
      },
    });
    let imagesDone!: () => void;
    waitForCardImages.mockImplementation(
      () =>
        new Promise((r) => {
          order.push('images:start');
          imagesDone = () => r({ total: 2, loaded: 2, failed: 0, timedOut: false });
        }),
    );
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      order.push('print');
    });

    useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
    render(
      <AppProviders api={api}>
        <RouterProvider router={createTestRouter(`/cards/print/${batch.id}?auto=1`)} />
      </AppProviders>,
    );
    // The supervisor's card carries the user photo in the sheet.
    await waitFor(() => expect(document.querySelectorAll('.nz-sheet .nz-card img.nz-photo').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(print).not.toHaveBeenCalled();
    fontsDone();
    await waitFor(() => expect(waitForCardImages).toHaveBeenCalled());
    expect(print).not.toHaveBeenCalled();
    imagesDone();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['fonts', 'images:start', 'print']);
    delete (document as { fonts?: unknown }).fonts;
  });
});
