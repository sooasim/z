'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { STATES } from '@/lib/statuses';
import { knownEnumLabel } from '@/lib/enums';

/** Machine enums used as chart labels (CONFIRMED, RESERVATION …) are shown localized. */
function useLabel() {
  const { lang } = useI18n();
  return (l: string) => {
    const st = STATES[String(l).toUpperCase()];
    if (st && /^[A-Z_]+$/.test(l)) return lang === 'ko' ? st[1] : st[2];
    return knownEnumLabel(l, lang) ?? l;
  };
}

/** Lightweight inline-SVG charts (no chart library). */
export function Sparkline({ data, stroke = 'var(--accent)', fill = true, height = 40, label }: { data: number[]; stroke?: string; fill?: boolean; height?: number; label?: string }) {
  const w = 160;
  const h = height;
  if (!data.length) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {fill && <path d={`${d} L${w} ${h} L0 ${h} Z`} fill={stroke} opacity="0.12" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={stroke} />
    </svg>
  );
}

export function BarChart({ data, height = 180, format = (n: number) => String(n), label }: { data: Array<{ label: string; value: number }>; height?: number; format?: (n: number) => string; label: string }) {
  const tr = useLabel();
  data = data.map((d) => ({ ...d, label: tr(d.label) }));
  const w = 600;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (w - pad.l - pad.r) / Math.max(1, data.length);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} className="grid-line" x1={pad.l} x2={w - pad.r} y1={pad.t + (height - pad.t - pad.b) * (1 - g)} y2={pad.t + (height - pad.t - pad.b) * (1 - g)} />
        ))}
        {data.map((d, i) => {
          const bh = ((height - pad.t - pad.b) * d.value) / max;
          const x = pad.l + i * bw + bw * 0.18;
          return (
            <g key={d.label}>
              <rect className="bar" x={x} y={height - pad.b - bh} width={bw * 0.64} height={Math.max(1, bh)} rx="4">
                <title>{`${d.label}: ${format(d.value)}`}</title>
              </rect>
              <text className="axis" x={x + bw * 0.32} y={height - 8} textAnchor="middle">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">{data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}</figcaption>
    </figure>
  );
}

export function Donut({ parts, size = 120, label }: { parts: Array<{ label: string; value: number; color: string }>; size?: number; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  const r = 15.9155;
  return (
    <svg width={size} height={size} viewBox="0 0 42 42" role="img" aria-label={label}>
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="6" />
      {parts.map((p) => {
        const pct = (p.value / total) * 100;
        const el = <circle key={p.label} cx="21" cy="21" r={r} fill="none" stroke={p.color} strokeWidth="6" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={25 - acc} />;
        acc += pct;
        return el;
      })}
    </svg>
  );
}

export function StatCard({ label, value, delta, trend, icon, hint }: { label: string; value: ReactNode; delta?: number; trend?: number[]; icon?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="row between">
        <span className="lbl">{label}</span>
        {icon}
      </div>
      <span className="val">{value}</span>
      <div className="row between" style={{ gap: 8 }}>
        {delta !== undefined && Number.isFinite(delta) ? (
          <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
          </span>
        ) : (
          <span className="xs muted">{hint}</span>
        )}
      </div>
      {trend && trend.length > 1 && <Sparkline data={trend} label={`${label} trend`} />}
    </div>
  );
}
