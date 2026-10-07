import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "지도에서 찾기",
  description: "지도에서 숙소를 탐색하세요.",
  alternates: { canonical: '/map' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
