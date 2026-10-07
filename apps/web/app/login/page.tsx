import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "로그인",
  description: "JETPOOL 로그인",
  alternates: { canonical: '/login' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
