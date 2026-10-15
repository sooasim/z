import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "관광 상품",
  description: "본사 직영 상품 등록·검수·공개와 출발일 재고",
  alternates: { canonical: '/admin/products' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
