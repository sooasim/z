import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "공급사 관리",
  description: "관리자 콘솔 — 여행 상품 공급사 심사와 수수료",
  alternates: { canonical: '/admin/suppliers' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
