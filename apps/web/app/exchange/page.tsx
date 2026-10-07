import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "한달살기 홈 맞교환",
  description: "검증된 회원끼리 서로의 집을 바꿔 사는 한 달",
  alternates: { canonical: '/exchange' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
