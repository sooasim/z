import type { ReactNode } from 'react';
import { AccountNav } from './nav';

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="with-side">
      <AccountNav />
      <div>{children}</div>
    </div>
  );
}
