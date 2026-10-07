import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "여행 일정표",
  description: "상품 일정",
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
