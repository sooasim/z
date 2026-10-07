import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "예약 결제",
  description: "숙소 예약 결제",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
