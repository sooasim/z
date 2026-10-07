import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "개인정보 · 동의",
  description: "동의 관리, 내보내기, 삭제",
  alternates: { canonical: '/account/privacy' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
