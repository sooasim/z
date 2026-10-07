import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "스토리",
  description: "한달살기·맞교환·로컬 라이프 이야기",
  alternates: { canonical: '/stories' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
