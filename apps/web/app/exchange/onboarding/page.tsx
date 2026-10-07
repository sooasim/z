import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "홈 맞교환 시작하기",
  description: "맞교환 자격 확인",
  alternates: { canonical: '/exchange/onboarding' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
