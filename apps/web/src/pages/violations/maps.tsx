import { useEffect, useRef, useState } from 'react';
import { Box, Button, Group, Text } from '@mantine/core';
import { IconSquareDashed, IconX } from '@tabler/icons-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { formatNumber, t } from '../../i18n';

/**
 * Leaflet maps for the violations screens (ADR-015: plain lat/lng, clustering in the browser).
 * OpenStreetMap tiles with their attribution kept. Tiles are never cached by the service worker.
 * The map container is `dir="ltr"`: Leaflet positions tiles with physical offsets, and a map
 * has no reading direction; labels around it stay RTL.
 */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
/** Riyadh, when there is nothing to fit. */
const DEFAULT_CENTER: L.LatLngExpression = [24.7136, 46.6753];

function baseMap(el: HTMLElement, opts: L.MapOptions = {}): L.Map {
  const map = L.map(el, { zoomControl: false, attributionControl: true, ...opts });
  // Drawers and collapses animate their size: keep the tiles aligned with the box.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    ro.observe(el);
    map.on('unload', () => ro.disconnect());
  }
  L.control.zoom({ zoomInTitle: t('map.zoomIn'), zoomOutTitle: t('map.zoomOut'), position: 'topleft' }).addTo(map);
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19, crossOrigin: true }).addTo(map);
  return map;
}

function pinIcon(color: string) {
  return L.divIcon({
    className: 'nz-pin',
    html: `<svg width="28" height="38" viewBox="0 0 28 38" aria-hidden="true"><path d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 22.6 14 37 14 37s12.5-14.4 12.5-23.7C26.5 6.4 21 1 14 1z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="14" cy="13.5" r="4.5" fill="#fff"/></svg>`,
    iconSize: [28, 38],
    iconAnchor: [14, 37],
  });
}

/** One violation: a pin and its GPS accuracy circle. */
export function LocationMap({
  lat,
  lng,
  accuracyM,
  color = '#C62828',
  height = 220,
}: {
  lat: number;
  lng: number;
  accuracyM: number;
  color?: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const map = baseMap(ref.current, { scrollWheelZoom: false });
    // Fit first: a circle can only measure itself on a map that already has a view.
    map.fitBounds(L.latLng(lat, lng).toBounds(Math.max(accuracyM, 25) * 3), { maxZoom: 17 });
    L.circle([lat, lng], {
      radius: Math.max(accuracyM, 1),
      color,
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.12,
    }).addTo(map);
    L.marker([lat, lng], { icon: pinIcon(color), keyboard: false }).addTo(map);
    return () => {
      map.remove();
    };
  }, [lat, lng, accuracyM, color]);
  return (
    <Box
      ref={ref}
      dir="ltr"
      className="nz-map"
      style={{ height }}
      role="img"
      aria-label={t('map.locationAria', { m: Math.round(accuracyM) })}
    />
  );
}

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  color: string | null;
}

/** "south,west,north,east", the format of the API's bbox filter. */
export function boundsToBbox(b: L.LatLngBounds): string {
  const r = (n: number) => n.toFixed(5);
  return `${r(b.getSouth())},${r(b.getWest())},${r(b.getNorth())},${r(b.getEast())}`;
}

function bboxToBounds(bbox: string): L.LatLngBounds | null {
  const [s, w, n, e] = bbox.split(',').map(Number);
  if ([s, w, n, e].some((x) => x === undefined || Number.isNaN(x))) return null;
  return L.latLngBounds([s!, w!], [n!, e!]);
}

/**
 * Many violations with marker clustering, optionally with a "draw an area" tool that sets the
 * list/dashboard bbox filter (brief §7.5).
 */
export function ClusterMap({
  points,
  height = 360,
  bbox,
  onBbox,
  onSelect,
}: {
  points: MapPoint[];
  height?: number;
  bbox?: string;
  onBbox?: (bbox: string | undefined) => void;
  onSelect?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const areaRef = useRef<L.Rectangle | null>(null);
  const [drawing, setDrawing] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!ref.current) return;
    const map = baseMap(ref.current);
    map.setView(DEFAULT_CENTER, 11);
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      iconCreateFunction: (c) => {
        const n = c.getChildCount();
        const size = n < 10 ? 34 : n < 100 ? 40 : 48;
        return L.divIcon({
          html: `<span>${formatNumber(n)}</span>`,
          className: 'nz-cluster',
          iconSize: [size, size],
        });
      },
    });
    map.addLayer(cluster);
    mapRef.current = map;
    clusterRef.current = cluster;
    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
  }, []);

  // Points
  useEffect(() => {
    const map = mapRef.current;
    const cluster = clusterRef.current;
    if (!map || !cluster) return;
    cluster.clearLayers();
    const markers = points.map((p) => {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: p.color ?? '#5B6B72',
        fillOpacity: 0.95,
      });
      m.on('click', () => onSelectRef.current?.(p.id));
      return m;
    });
    cluster.addLayers(markers as unknown as L.Layer[]);
    if (points.length && !bbox) {
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), {
        maxZoom: 15,
        padding: [24, 24],
      });
    }
    // Only the data drives the view, not the drawn area.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  // The drawn area (from the filter)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    areaRef.current?.remove();
    areaRef.current = null;
    const b = bbox ? bboxToBounds(bbox) : null;
    if (b) {
      areaRef.current = L.rectangle(b, {
        color: '#5030e5',
        weight: 2,
        dashArray: '6 4',
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(map);
    }
  }, [bbox]);

  // Drawing a rectangle: press, drag, release.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !drawing) return;
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
    let start: L.LatLng | null = null;
    let rect: L.Rectangle | null = null;
    const down = (e: L.LeafletMouseEvent) => {
      start = e.latlng;
      rect = L.rectangle(L.latLngBounds(start, start), { color: '#5030e5', weight: 2, fillOpacity: 0.08 }).addTo(map);
    };
    const move = (e: L.LeafletMouseEvent) => {
      if (start && rect) rect.setBounds(L.latLngBounds(start, e.latlng));
    };
    const up = (e: L.LeafletMouseEvent) => {
      if (!start || !rect) return;
      const b = L.latLngBounds(start, e.latlng);
      rect.remove();
      start = null;
      rect = null;
      setDrawing(false);
      if (b.getNorth() - b.getSouth() > 1e-5 && b.getEast() - b.getWest() > 1e-5) onBbox?.(boundsToBbox(b));
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);
    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      rect?.remove();
      map.dragging.enable();
      map.getContainer().style.cursor = '';
    };
  }, [drawing, onBbox]);

  return (
    <Box>
      {onBbox ? (
        <Group justify="space-between" mb="xs" gap="xs" wrap="wrap">
          <Text size="sm" c="dimmed">
            {drawing ? t('map.drawHint') : bbox ? t('map.areaActive') : t('map.areaHint')}
          </Text>
          <Group gap="xs">
            {bbox ? (
              <Button size="compact-sm" variant="subtle" color="slate" leftSection={<IconX size={14} />} onClick={() => onBbox(undefined)}>
                {t('map.clearArea')}
              </Button>
            ) : null}
            <Button
              size="compact-sm"
              variant={drawing ? 'filled' : 'light'}
              leftSection={<IconSquareDashed size={14} />}
              onClick={() => setDrawing((d) => !d)}
              aria-pressed={drawing}
            >
              {drawing ? t('map.cancelDraw') : t('map.drawArea')}
            </Button>
          </Group>
        </Group>
      ) : null}
      <Box ref={ref} dir="ltr" className="nz-map" style={{ height }} aria-label={t('map.clusterAria', { n: points.length })} role="region" />
    </Box>
  );
}
