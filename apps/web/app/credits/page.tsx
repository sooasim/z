import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '사진 출처 · 라이선스',
  description: 'JETPOOL에 쓰인 오픈 라이선스 사진(CC BY · CC BY-SA · CC0 · PDM)의 작가, 라이선스와 원본 링크',
  alternates: { canonical: '/credits' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
