import type { ReactNode } from 'react';
import { HostNav } from './nav';

export default function HostLayout({ children }: { children: ReactNode }) {
  return (
    <div className="with-side">
      <HostNav />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
