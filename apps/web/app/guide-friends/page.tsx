import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "가이드 프렌드",
  description: "프렌드·자원봉사·유료·전문 로컬 가이드",
  alternates: { canonical: '/guide-friends' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
