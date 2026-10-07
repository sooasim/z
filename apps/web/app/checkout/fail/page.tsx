import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "결제 실패",
  description: "결제 실패",
  alternates: { canonical: '/checkout/fail' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
