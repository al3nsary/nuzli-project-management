/**
 * «الغلاف» in the project settings (A12 round 2): preview (the uploaded image or the generated
 * cover), upload with a 16:9 crop (drag / arrows to pan, slider / wheel / + − to zoom), and remove.
 * The cropped JPEG (≤ 3 MB) goes through `api.projects.uploadCover`; `projects.manage` only.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Alert, Button, FileButton, Group, Slider, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPhotoUp, IconTrash, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { a12k } from '../../api/a12Queries';
import { invalidateProjectReads } from '../../api/a9Queries';
import { qk4 } from '../../api/projectQueries';
import { formatNumber, t } from '../../i18n';
import { loadImage, prepareSource, type LoadedImage } from '../photos/crop';
import { COVER_MAX_ZOOM, coverRect, coverTypeOk, initialCover, panCover, renderCover, zoomCover, type CoverCrop } from './coverCrop';
import { ProjectCover, type CoverProject } from './ProjectCover';
import './cover.css';

const KEY_STEP = 12;

export function CoverPanel({ project }: { project: CoverProject }) {
  const api = useApi();
  const qc = useQueryClient();
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [crop, setCrop] = useState<CoverCrop>({ zoom: 1, cx: 0, cy: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => image?.release(), [image]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.gantt(project.id) });
    invalidateProjectReads(qc, project.id);
    void qc.invalidateQueries({ queryKey: a12k.cover(project.id) });
  };

  const pick = async (file: File | null) => {
    if (!file) return;
    setError(null);
    if (!coverTypeOk(file.type)) {
      setError(t('a12roles.cover.typeError'));
      return;
    }
    try {
      const prepared = await prepareSource(file);
      const img = await loadImage(prepared);
      setImage(img);
      setCrop(initialCover(img.width, img.height));
    } catch {
      setError(t('a12roles.cover.readError'));
    }
  };

  const save = async () => {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await renderCover(image.source, image.width, image.height, crop);
      await api.projects.uploadCover(project.id, blob);
      await refresh();
      setImage(null);
      notifications.show({ color: 'ok', message: t('a12roles.cover.saved') });
    } catch (err) {
      setError(err instanceof Error && err.message === 'too-large' ? t('a12roles.cover.tooLarge') : err instanceof Error && ['canvas', 'encode'].includes(err.message) ? t('a12roles.cover.readError') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    modals.openConfirmModal({
      title: t('a12roles.cover.removeTitle'),
      children: <Text size="sm">{t('a12roles.cover.removeBody')}</Text>,
      labels: { confirm: t('a12roles.cover.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.projects.removeCover(project.id);
          await refresh();
          notifications.show({ color: 'ok', message: t('a12roles.cover.removed') });
        } catch (err) {
          setError(errorMessage(err));
        }
      },
    });

  return (
    <Stack gap="sm" className="nz-cover-editor">
      <div>
        <Text fw={600}>{t('a12roles.cover.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('a12roles.cover.lead')}
        </Text>
      </div>
      {error ? (
        <Alert color="breach" role="alert">
          {error}
        </Alert>
      ) : null}
      {image ? (
        <>
          <CoverCropper image={image} crop={crop} onChange={setCrop} />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setImage(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void save()} loading={busy} data-testid="cover-save">
              {t('a12roles.cover.saveCrop')}
            </Button>
          </Group>
        </>
      ) : (
        <>
          <ProjectCover project={project} variant="frame" />
          <Text size="xs" c="dimmed">
            {project.hasCover ? t('a12roles.cover.preview') : t('a12roles.cover.generated')}
            {' · '}
            {t('a12roles.cover.sizeHint')}
          </Text>
          <Group gap="xs" wrap="wrap">
            <FileButton onChange={(f) => void pick(f)} accept="image/jpeg,image/png,image/webp">
              {(props) => (
                <Button {...props} leftSection={<IconPhotoUp size={18} />} data-testid="cover-upload">
                  {project.hasCover ? t('a12roles.cover.replace') : t('a12roles.cover.upload')}
                </Button>
              )}
            </FileButton>
            {project.hasCover ? (
              <Button variant="light" color="breach" leftSection={<IconTrash size={18} />} onClick={remove} data-testid="cover-remove">
                {t('a12roles.cover.remove')}
              </Button>
            ) : null}
          </Group>
        </>
      )}
    </Stack>
  );
}

/** A fixed 16:9 frame: the picture pans under it (pointer, arrows) and zooms (slider, wheel, + −). */
function CoverCropper({ image, crop, onChange }: { image: LoadedImage; crop: CoverCrop; onChange(c: CoverCrop): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef(crop);
  latest.current = crop;
  const helpId = useId();
  const { width: w, height: h } = image;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const r = coverRect(w, h, crop);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image.source, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  }, [image, crop, w, h]);

  const viewW = () => ref.current?.getBoundingClientRect().width || 320;
  const change = useCallback((c: CoverCrop) => onChange(c), [onChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = latest.current;
      change(zoomCover(w, h, s, s.zoom * (1 - e.deltaY * 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [w, h, change]);

  // Pointer deltas and the canvas are both physical: the picture follows the finger in RTL and LTR.
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const prev = last.current;
    if (!prev) return;
    last.current = { x: e.clientX, y: e.clientY };
    change(panCover(w, h, latest.current, e.clientX - prev.x, e.clientY - prev.y, viewW()));
  };
  const up = () => {
    last.current = null;
  };
  const key = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const s = latest.current;
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let next: CoverCrop | null = null;
    // Arrow keys are physical: the picture moves the way the arrow points.
    if (e.key === 'ArrowLeft') next = panCover(w, h, s, -step, 0, viewW());
    else if (e.key === 'ArrowRight') next = panCover(w, h, s, step, 0, viewW());
    else if (e.key === 'ArrowUp') next = panCover(w, h, s, 0, -step, viewW());
    else if (e.key === 'ArrowDown') next = panCover(w, h, s, 0, step, viewW());
    else if (e.key === '+' || e.key === '=') next = zoomCover(w, h, s, s.zoom + 0.1);
    else if (e.key === '-' || e.key === '_') next = zoomCover(w, h, s, s.zoom - 0.1);
    else if (e.key === '0') next = initialCover(w, h);
    if (next) {
      e.preventDefault();
      change(next);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {t('a12roles.cover.cropTitle')}
      </Text>
      <div className="nz-cover-crop">
        <canvas
          ref={ref}
          width={Math.round(640 * dpr)}
          height={Math.round(360 * dpr)}
          tabIndex={0}
          role="application"
          aria-label={t('a12roles.cover.frame')}
          aria-describedby={helpId}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={key}
          data-testid="cover-cropper"
        />
      </div>
      <Text id={helpId} size="xs" c="dimmed">
        {t('a12roles.cover.cropHint')}
      </Text>
      {/* The zoom track runs out → in from left to right in both directions, like its icons. */}
      <Group gap="xs" wrap="nowrap" dir="ltr">
        <IconZoomOut size={18} aria-hidden />
        <Slider
          style={{ flex: 1 }}
          min={1}
          max={COVER_MAX_ZOOM}
          step={0.01}
          value={crop.zoom}
          onChange={(z) => change(zoomCover(w, h, latest.current, z))}
          label={(z) => `${formatNumber(Math.round(z * 100))}٪`}
          thumbProps={{ 'aria-label': t('a12roles.cover.zoom') }}
          color="field"
        />
        <IconZoomIn size={18} aria-hidden />
      </Group>
    </Stack>
  );
}
