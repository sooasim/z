import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "로그인 처리",
  description: "소셜 로그인",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
