import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "투어 · 티켓 · 패키지",
  description: "검증된 공급사의 여행 상품",
  alternates: { canonical: '/travel' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
