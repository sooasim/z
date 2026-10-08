import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '브랜드 아카이브',
  description: '원여행클럽(WONT Travel Club) wontc.co.kr에서 옮겨 온 사진과 이미지 전체 — 페이지별로 모아 보기',
  alternates: { canonical: '/archive' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
