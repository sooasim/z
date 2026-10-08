import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '브랜드 이야기',
  description: 'JETPOOL과 원여행클럽(WONT Travel Club) — 원치승 대표, 마음편지, 한달살기 맞교환, 전세기 공유까지 wontc.co.kr에서 옮겨 온 이야기',
  alternates: { canonical: '/about' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
