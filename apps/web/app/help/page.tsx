import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '사용 안내 — 회원 등급별 기능',
  description: 'JETPOOL을 여행자·호스트·맞교환 회원·가이드·공급사·정산·운영자로 쓰는 방법. 등급마다 열리는 페이지와 버튼의 역할을 설명합니다.',
  alternates: { canonical: '/help' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
