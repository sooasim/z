import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "여행지 탐색",
  description: "JETPOOL 멤버들이 살아본 도시",
  alternates: { canonical: '/discover' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
