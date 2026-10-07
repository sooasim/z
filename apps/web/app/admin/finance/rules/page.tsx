import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "수수료·세금 규칙",
  description: "유효기간 기반 규칙",
  alternates: { canonical: '/admin/finance/rules' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
