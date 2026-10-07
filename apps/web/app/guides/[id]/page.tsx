import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "가이드 프로필",
  description: "로컬 가이드 프렌드",
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
