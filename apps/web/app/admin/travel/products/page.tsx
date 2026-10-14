import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "여행 상품 관리",
  description: "관리자 콘솔 — 여행 상품 등록, 심사, 출발일 관리",
  alternates: { canonical: '/admin/travel/products' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
