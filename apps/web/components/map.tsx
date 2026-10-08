'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap, MapOptions, Marker as MlMarker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useI18n } from '@/lib/i18n';
import { Icon } from './ui/icons';

type MapLibre = typeof import('maplibre-gl');

/**
 * maplibre-gl v6 is ESM-only (named exports, no default) and starts its worker from a URL derived from its own
 * import.meta.url, which a bundled chunk does not keep. Point it at the worker module explicitly: webpack turns
 * `new URL('<pkg file>', import.meta.url)` into a hashed same-origin static asset, so CSP `worker-src 'self'` covers it.
 */
async function loadMapLibre(): Promise<MapLibre> {
  const lib = await import('maplibre-gl');
  lib.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
  return lib;
}

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  /** Pin text (price, or a short tag such as "맞교환"). */
  label: string;
  /** Listing title — part of the pin's accessible name ("성수 감성 아파트, ₩120,000"). */
  title?: string;
  href?: string;
}

/**
 * Basemap configuration (production must not use tile.openstreetmap.org — its usage policy forbids commercial
 * traffic): set NEXT_PUBLIC_MAP_STYLE_URL to a vector style (MapTiler / Protomaps / self-hosted) or
 * NEXT_PUBLIC_MAP_TILE_URL to a raster template ("https://…/{z}/{x}/{y}.png"); the OSM raster default is for dev.
 * Remember to allow the tile host in the CSP connect-src / img-src.
 */
const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || '';
const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: { type: 'raster', tiles: [TILE_URL], tileSize: 256, maxzoom: 19, attribution: TILE_ATTRIBUTION },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};
const MAP_STYLE: Exclude<MapOptions['style'], undefined> = STYLE_URL || OSM_STYLE;

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

const CLUSTER_PX = 46;
const TILE_FAIL_THRESHOLD = 4;

interface Group {
  pts: MapPoint[];
  lng: number;
  lat: number;
}

/**
 * MapLibre GL map. Exact property addresses are never sent to the client before confirmation (API returns fuzzed
 * coordinates); pins show approximate locations.
 * - `onMove` fires only for user gestures (drag/zoom), not for the initial fit — "search this area" stays hidden
 *   until the user actually moves the map.
 * - Pins closer than ~46px are clustered ("3"); a click zooms in, and pins sharing one spot fan out at high zoom.
 * - Tile failures show a quiet "지도를 불러오지 못했어요 · 다시 시도" overlay (pins keep working) instead of a blank
 *   map and console noise.
 */
export function MapView({ points, onMove, height = 480, center = [126.978, 37.5665], zoom = 6, activeId, onPinHover, fill }: { points: MapPoint[]; onMove?: (b: Bounds) => void; height?: number | string; center?: [number, number]; zoom?: number; activeId?: string | null; onPinHover?: (id: string | null) => void; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<MlMarker[]>([]);
  const elsRef = useRef<Map<string, HTMLElement>>(new Map());
  const hoverRef = useRef(onPinHover);
  hoverRef.current = onPinHover;
  const libRef = useRef<MapLibre | null>(null);
  const [failed, setFailed] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const tileErrors = useRef(0);
  const tileOk = useRef(false);
  const { L } = useI18n();
  const lRef = useRef(L);
  lRef.current = L;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  // Latest points for callbacks registered once (avoids a stale closure from the first render).
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const fittedFor = useRef('');

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const lib = await loadMapLibre();
        if (disposed || !ref.current) return;
        libRef.current = lib;
        const map = new lib.Map({ container: ref.current, style: MAP_STYLE, center, zoom, attributionControl: { compact: true }, cooperativeGestures: false });
        map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        map.on('moveend', (e: any) => {
          if (!e?.originalEvent) return; // programmatic (fitBounds / jumpTo) → not a user search intent
          const b = map.getBounds();
          onMoveRef.current?.({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
        });
        map.on('zoomend', () => renderMarkers(false));
        // A registered 'error' listener also stops maplibre from console.error-ing every failed tile.
        map.on('error', (e: any) => {
          const isTile = !!(e?.tile || e?.sourceId || /tile|fetch|network|load/i.test(String(e?.error?.message ?? '')));
          if (!isTile) return;
          tileErrors.current += 1;
          if (!tileOk.current && tileErrors.current >= TILE_FAIL_THRESHOLD) {
            setTilesFailed(true);
            try {
              if (map.getLayer('osm')) map.setLayoutProperty('osm', 'visibility', 'none'); // stop hammering a dead tile host
            } catch {
              /* style not ready */
            }
          }
        });
        map.on('data', (e: any) => {
          if (e?.dataType === 'source' && e?.tile && e.tile.state === 'loaded') tileOk.current = true;
        });
        mapRef.current = map;
        // Markers are DOM overlays: render them right away rather than on 'load', which waits for tiles
        // (slow or blocked tile servers would otherwise hide every price pin).
        renderMarkers(true);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryTiles = () => {
    const map = mapRef.current;
    if (!map) return;
    tileErrors.current = 0;
    setTilesFailed(false);
    try {
      if (map.getLayer('osm')) {
        map.setLayoutProperty('osm', 'visibility', 'visible');
        const src: any = map.getSource('osm');
        src?.setTiles?.([TILE_URL]);
      } else map.setStyle(MAP_STYLE);
    } catch {
      map.setStyle(MAP_STYLE);
    }
  };

  const group = (map: MlMap, valid: MapPoint[]): Group[] => {
    const groups: Array<Group & { x: number; y: number }> = [];
    for (const p of valid) {
      const px = map.project([p.lng, p.lat]);
      const g = groups.find((c) => Math.hypot(c.x - px.x, c.y - px.y) < CLUSTER_PX);
      if (g) {
        g.pts.push(p);
        g.lng = (g.lng * (g.pts.length - 1) + p.lng) / g.pts.length;
        g.lat = (g.lat * (g.pts.length - 1) + p.lat) / g.pts.length;
      } else groups.push({ pts: [p], lng: p.lng, lat: p.lat, x: px.x, y: px.y });
    }
    return groups;
  };

  const pinEl = (p: MapPoint) => {
    const el = document.createElement(p.href ? 'a' : 'span');
    el.className = 'map-pin';
    el.textContent = p.label;
    if (p.href) (el as HTMLAnchorElement).href = p.href;
    else el.setAttribute('role', 'img');
    el.setAttribute('aria-label', p.title ? `${p.title}, ${p.label}` : p.label);
    if (p.title) el.title = p.title;
    el.addEventListener('mouseenter', () => hoverRef.current?.(p.id));
    el.addEventListener('mouseleave', () => hoverRef.current?.(null));
    el.addEventListener('focus', () => hoverRef.current?.(p.id));
    el.addEventListener('blur', () => hoverRef.current?.(null));
    return el;
  };

  const renderMarkers = (fit: boolean) => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    const valid = pointsRef.current.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const key = valid.map((p) => p.id).join(',');
    if (fit && fittedFor.current !== key) {
      fittedFor.current = key;
      if (valid.length > 1) {
        const b = new lib.LngLatBounds();
        valid.forEach((p) => b.extend([p.lng, p.lat]));
        map.fitBounds(b, { padding: 56, maxZoom: 13, duration: 0 });
      } else if (valid.length === 1) map.jumpTo({ center: [valid[0].lng, valid[0].lat], zoom: 12 });
    }
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    elsRef.current.clear();
    const L = lRef.current;
    const maxed = map.getZoom() >= Math.min(map.getMaxZoom(), 15);
    for (const g of group(map, valid)) {
      if (g.pts.length === 1 || maxed) {
        // Single pin — or pins that still collide at high zoom (same building): fan them out in a ring.
        g.pts.forEach((p, i) => {
          const el = pinEl(p);
          elsRef.current.set(p.id, el);
          const n = g.pts.length;
          const off: [number, number] = n > 1 ? [Math.round(Math.cos((2 * Math.PI * i) / n) * 34), Math.round(Math.sin((2 * Math.PI * i) / n) * 26)] : [0, 0];
          markersRef.current.push(new lib.Marker({ element: el, offset: off }).setLngLat(n > 1 ? [g.lng, g.lat] : [p.lng, p.lat]).addTo(map));
        });
        continue;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'map-pin cluster';
      el.textContent = String(g.pts.length);
      el.setAttribute('aria-label', L(`이 지역 숙소 ${g.pts.length}곳 — 확대해서 보기`, `${g.pts.length} stays here — zoom in`));
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        const b = new lib.LngLatBounds();
        g.pts.forEach((p) => b.extend([p.lng, p.lat]));
        const same = g.pts.every((p) => Math.abs(p.lat - g.pts[0].lat) < 1e-5 && Math.abs(p.lng - g.pts[0].lng) < 1e-5);
        if (same) map.easeTo({ center: [g.lng, g.lat], zoom: Math.max(map.getZoom() + 3, 15) });
        else map.fitBounds(b, { padding: 80, maxZoom: 16 });
      });
      el.addEventListener('mouseenter', () => hoverRef.current?.(g.pts[0].id));
      el.addEventListener('mouseleave', () => hoverRef.current?.(null));
      g.pts.forEach((p) => elsRef.current.set(p.id, el));
      markersRef.current.push(new lib.Marker({ element: el }).setLngLat([g.lng, g.lat]).addTo(map));
    }
    elsRef.current.forEach((el, id) => el.classList.toggle('active', id === activeRef.current));
  };

  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  useEffect(() => {
    if (mapRef.current) renderMarkers(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points)]);

  useEffect(() => {
    elsRef.current.forEach((el) => el.classList.remove('active'));
    if (activeId) elsRef.current.get(activeId)?.classList.add('active');
  }, [activeId, points]);

  if (failed)
    return (
      <div className="map map-fallback" style={{ height: fill ? '100%' : height }} role="status">
        <Icon name="map" size={28} />
        <span>{L('지도를 불러올 수 없습니다.', 'Map unavailable.')}</span>
      </div>
    );
  return (
    <div className="map-wrap" style={{ height: fill ? '100%' : height }}>
      <div ref={ref} className={`map ${tilesFailed ? 'tiles-failed' : ''}`} style={{ height: '100%' }} role="region" aria-label={L('지도 (대략적 위치)', 'Map (approximate locations)')} />
      {tilesFailed && (
        <div className="map-error" role="status">
          <Icon name="alert-circle" size={18} />
          <span>{L('지도를 불러오지 못했어요', 'Couldn’t load the map')}</span>
          <button type="button" className="btn sm" onClick={retryTiles}>
            <Icon name="refresh" size={16} /> {L('다시 시도', 'Retry')}
          </button>
        </div>
      )}
    </div>
  );
}
