import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "결제 확인",
  description: "결제 승인 확인",
  alternates: { canonical: '/checkout/success' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
