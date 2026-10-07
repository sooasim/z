'use client';
import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useI18n } from '@/lib/i18n';

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  href?: string;
}

/** Free OSM raster style — no API key. Respect the OSM tile usage policy (attribution, modest traffic). */
export const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
};

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * MapLibre GL map. Exact property addresses are never sent to the client before confirmation (API returns fuzzed
 * coordinates); pins show approximate locations. Calls onMove with the viewport bounds for "search this area".
 */
export function MapView({ points, onMove, height = 480, center = [126.978, 37.5665], zoom = 6 }: { points: MapPoint[]; onMove?: (b: Bounds) => void; height?: number; center?: [number, number]; zoom?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const libRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);
  const { L } = useI18n();
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const lib = (await import('maplibre-gl')).default;
        if (disposed || !ref.current) return;
        libRef.current = lib;
        const map = new lib.Map({ container: ref.current, style: OSM_STYLE as any, center, zoom, attributionControl: { compact: true } });
        map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        map.on('moveend', () => {
          const b = map.getBounds();
          onMoveRef.current?.({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
        });
        mapRef.current = map;
        map.on('load', () => renderMarkers());
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

  const renderMarkers = () => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    for (const p of valid) {
      const el = document.createElement(p.href ? 'a' : 'span');
      el.className = 'map-pin';
      el.textContent = p.label;
      if (p.href) (el as HTMLAnchorElement).href = p.href;
      el.setAttribute('aria-label', p.label);
      markersRef.current.push(new lib.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
    }
    if (valid.length > 1) {
      const b = new lib.LngLatBounds();
      valid.forEach((p) => b.extend([p.lng, p.lat]));
      map.fitBounds(b, { padding: 48, maxZoom: 13, duration: 0 });
    } else if (valid.length === 1) map.jumpTo({ center: [valid[0].lng, valid[0].lat], zoom: 12 });
  };

  useEffect(() => {
    if (mapRef.current?.loaded()) renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points)]);

  if (failed)
    return (
      <div className="map state" style={{ height }}>
        {L('지도를 불러올 수 없습니다.', 'Map unavailable.')}
      </div>
    );
  return <div ref={ref} className="map" style={{ height }} role="region" aria-label={L('지도 (대략적 위치)', 'Map (approximate locations)')} />;
}
