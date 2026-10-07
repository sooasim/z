import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "숙소 검색",
  description: "검증된 숙소를 날짜·인원·지도로 검색하세요.",
  alternates: { canonical: '/stay' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
