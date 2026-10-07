import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "전세기 공유 JETPOOL",
  description: "WONT Travel Club 전세기 공유 여행 — 사전 수요 접수",
  alternates: { canonical: '/jetpool-charter' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
