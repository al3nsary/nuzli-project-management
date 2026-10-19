import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Group, Slider, Stack, Text } from '@mantine/core';
import { IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import {
  cropRect,
  maxZoom,
  panBy,
  zoomTo,
  type CropState,
  type LoadedImage,
} from '../../features/photos/crop';
import { formatNumber, t } from '../../i18n';

const KEY_STEP = 12;
const KEY_STEP_FAST = 48;
const ZOOM_STEP = 0.1;

function draw(canvas: HTMLCanvasElement | null, image: LoadedImage, state: CropState, guide: 'circle' | 'card' | 'none') {
  if (!canvas) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const r = cropRect(image.width, image.height, state);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  if (guide === 'card') {
    // The card frame is 3:4 with object-fit: cover — the middle of the square.
    const sw = r.side * 0.75;
    ctx.drawImage(image.source, r.x + (r.side - sw) / 2, r.y, sw, r.side, 0, 0, W, H);
    return;
  }
  ctx.drawImage(image.source, r.x, r.y, r.side, r.side, 0, 0, W, H);
  if (guide === 'circle') {
    // Dim outside the circle (the avatar), keep the square (the upload).
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(15, 17, 21, 0.5)';
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 1.5 * (W / 300), 0, Math.PI * 2);
    ctx.strokeStyle = '#7b61f0';
    ctx.lineWidth = 2 * (W / 300);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Square crop with a circular guide (the output stays square, 600×600). Drag or pinch to move
 * and zoom; on the keyboard the arrows move the picture, + and − zoom, 0 resets.
 */
export function PhotoCropper({
  image,
  state,
  onChange,
  viewPx = 280,
}: {
  image: LoadedImage;
  state: CropState;
  onChange: (s: CropState) => void;
  viewPx?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const circleRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const helpId = useId();
  const { width: w, height: h } = image;
  const zMax = maxZoom(w, h);
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  useEffect(() => {
    draw(canvasRef.current, image, state, 'circle');
    draw(circleRef.current, image, state, 'none');
    draw(cardRef.current, image, state, 'card');
  }, [image, state]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = latest.current;
      onChange(zoomTo(w, h, s, s.zoom * (1 - e.deltaY * 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [w, h, onChange]);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: latest.current.zoom };
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      onChange(zoomTo(w, h, latest.current, pinch.current.zoom * (dist / Math.max(1, pinch.current.dist))));
      return;
    }
    // Physical pointer deltas on a physical canvas: no direction sign.
    onChange(panBy(w, h, latest.current, e.clientX - prev.x, e.clientY - prev.y, viewPx));
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    const s = latest.current;
    let next: CropState | null = null;
    // Arrow keys are physical directions on screen; the picture moves the way the arrow points.
    if (e.key === 'ArrowLeft') next = panBy(w, h, s, -step, 0, viewPx);
    else if (e.key === 'ArrowRight') next = panBy(w, h, s, step, 0, viewPx);
    else if (e.key === 'ArrowUp') next = panBy(w, h, s, 0, -step, viewPx);
    else if (e.key === 'ArrowDown') next = panBy(w, h, s, 0, step, viewPx);
    else if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') next = zoomTo(w, h, s, s.zoom + ZOOM_STEP);
    else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') next = zoomTo(w, h, s, s.zoom - ZOOM_STEP);
    else if (e.key === '0') next = { zoom: 1, cx: w / 2, cy: h / 2 };
    if (next) {
      e.preventDefault();
      onChange(next);
    }
  };

  return (
    <Stack gap="sm" align="center">
      <canvas
        ref={canvasRef}
        className="nz-cropper"
        width={Math.round(viewPx * dpr)}
        height={Math.round(viewPx * dpr)}
        style={{ width: viewPx, height: viewPx }}
        tabIndex={0}
        role="application"
        aria-roledescription={t('photo.crop.role')}
        aria-label={t('photo.crop.area')}
        aria-describedby={helpId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        data-testid="photo-cropper"
      />
      <Text id={helpId} size="xs" c="dimmed" ta="center" maw={viewPx + 40}>
        {t('photo.crop.help')}
      </Text>
      {/* The zoom track runs left (out) to right (in) in both directions, like the icons. */}
      <Group gap="xs" wrap="nowrap" w={viewPx} dir="ltr">
        <IconZoomOut size={18} aria-hidden />
        <Slider
          style={{ flex: 1 }}
          min={1}
          max={zMax}
          step={0.01}
          value={state.zoom}
          onChange={(z) => onChange(zoomTo(w, h, latest.current, z))}
          label={(z) => `${formatNumber(Math.round(z * 100))}٪`}
          disabled={zMax <= 1}
          thumbProps={{ 'aria-label': t('photo.crop.zoom') }}
          color="field"
        />
        <IconZoomIn size={18} aria-hidden />
      </Group>
      <Group gap="lg" justify="center" align="flex-end">
        <Stack gap={4} align="center">
          <canvas
            ref={circleRef}
            width={Math.round(64 * dpr)}
            height={Math.round(64 * dpr)}
            className="nz-crop-preview nz-crop-preview--circle"
            aria-hidden
          />
          <Text size="xs" c="dimmed">
            {t('photo.preview.avatar')}
          </Text>
        </Stack>
        <Stack gap={4} align="center">
          <canvas
            ref={cardRef}
            width={Math.round(48 * dpr)}
            height={Math.round(64 * dpr)}
            className="nz-crop-preview nz-crop-preview--card"
            aria-hidden
          />
          <Text size="xs" c="dimmed">
            {t('photo.preview.card')}
          </Text>
        </Stack>
      </Group>
    </Stack>
  );
}
