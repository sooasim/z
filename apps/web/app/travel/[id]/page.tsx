import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "여행 상품",
  description: "여행 상품 상세",
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
