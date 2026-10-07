/** Inline SVG spot illustrations for empty/error/permission states (brand palette, theme-aware via currentColor). */
export type IlloName = 'search' | 'trips' | 'messages' | 'saved' | 'generic' | 'error' | 'lock' | 'calendar' | 'payments' | 'offline';

export function Illustration({ name = 'generic', className = 'illo' }: { name?: IlloName; className?: string }) {
  const common = { className, viewBox: '0 0 140 110', 'aria-hidden': true as const, fill: 'none' };
  const ground = <ellipse cx="70" cy="100" rx="52" ry="6" fill="var(--surface-3)" />;
  switch (name) {
    case 'search':
      return (
        <svg {...common}>
          {ground}
          <rect x="22" y="22" width="76" height="56" rx="10" fill="var(--brand-soft)" />
          <path d="M30 64l14-14 10 10 10-16 16 20" stroke="var(--navy-300)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="92" cy="58" r="20" fill="var(--surface)" stroke="var(--accent)" strokeWidth="5" />
          <path d="M106 72l14 14" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" />
        </svg>
      );
    case 'trips':
      return (
        <svg {...common}>
          {ground}
          <rect x="38" y="34" width="64" height="58" rx="10" fill="var(--accent)" />
          <rect x="54" y="22" width="32" height="14" rx="5" stroke="var(--navy-700)" strokeWidth="4" />
          <path d="M38 56h64" stroke="#fff" strokeOpacity=".5" strokeWidth="3" />
          <circle cx="50" cy="94" r="4" fill="var(--navy-700)" />
          <circle cx="90" cy="94" r="4" fill="var(--navy-700)" />
          <path d="M14 30c10-10 22-12 30-6" stroke="var(--navy-300)" strokeWidth="2" strokeDasharray="3 4" />
          <path d="M110 24l12-4-4 12" fill="var(--navy-500)" />
        </svg>
      );
    case 'messages':
      return (
        <svg {...common}>
          {ground}
          <rect x="18" y="24" width="64" height="44" rx="14" fill="var(--brand-soft)" />
          <path d="M32 68v12l12-12" fill="var(--brand-soft)" />
          <rect x="58" y="44" width="64" height="40" rx="14" fill="var(--accent)" />
          <path d="M108 84v10l-12-10" fill="var(--accent)" />
          <circle cx="76" cy="64" r="4" fill="#fff" /><circle cx="90" cy="64" r="4" fill="#fff" /><circle cx="104" cy="64" r="4" fill="#fff" />
        </svg>
      );
    case 'saved':
      return (
        <svg {...common}>
          {ground}
          <path d="M70 92S30 68 26 46c-3-16 8-26 20-26 10 0 18 6 24 14 6-8 14-14 24-14 12 0 23 10 20 26-4 22-44 46-44 46Z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="4" />
          <path d="M108 18l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z" fill="var(--navy-500)" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          {ground}
          <rect x="30" y="22" width="80" height="70" rx="12" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="3" />
          <rect x="30" y="22" width="80" height="18" rx="9" fill="var(--brand)" />
          {[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => <rect key={`${r}${c}`} x={38 + c * 14} y={48 + r * 10} width="9" height="6" rx="2" fill={r === 1 && c === 2 ? 'var(--accent)' : 'var(--surface-3)'} />))}
        </svg>
      );
    case 'payments':
      return (
        <svg {...common}>
          {ground}
          <rect x="22" y="30" width="84" height="54" rx="10" fill="var(--brand)" />
          <rect x="22" y="42" width="84" height="10" fill="var(--navy-900)" />
          <rect x="32" y="64" width="30" height="8" rx="3" fill="#fff" fillOpacity=".6" />
          <circle cx="104" cy="74" r="18" fill="var(--accent)" />
          <path d="M96 74l6 6 10-12" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          {ground}
          <rect x="40" y="46" width="60" height="46" rx="10" fill="var(--brand)" />
          <path d="M52 46V36a18 18 0 0 1 36 0v10" stroke="var(--brand)" strokeWidth="8" />
          <circle cx="70" cy="66" r="6" fill="var(--accent)" />
          <rect x="67" y="68" width="6" height="12" rx="3" fill="var(--accent)" />
        </svg>
      );
    case 'error':
    case 'offline':
      return (
        <svg {...common}>
          {ground}
          <path d="M70 18 120 92H20L70 18Z" fill="var(--warn-soft)" stroke="var(--warn)" strokeWidth="4" strokeLinejoin="round" />
          <path d="M70 44v22" stroke="var(--warn)" strokeWidth="7" strokeLinecap="round" />
          <circle cx="70" cy="78" r="4.5" fill="var(--warn)" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          {ground}
          <circle cx="70" cy="52" r="34" fill="var(--brand-soft)" />
          <path d="M44 66c8-16 18-24 26-24s18 8 26 24" stroke="var(--navy-500)" strokeWidth="4" strokeLinecap="round" />
          <circle cx="86" cy="36" r="8" fill="var(--accent)" />
        </svg>
      );
  }
}
