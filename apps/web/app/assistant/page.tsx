import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "AI 여행 도우미",
  description: "일정·지역·예산에 맞춘 여행 추천",
  alternates: { canonical: '/assistant' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
