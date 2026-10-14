import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "예약 관리",
  description: "관리자 콘솔 — 숙소 예약, 홈 맞교환, 가이드 예약",
  alternates: { canonical: '/admin/bookings' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
