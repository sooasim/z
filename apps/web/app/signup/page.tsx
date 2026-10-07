import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "회원가입",
  description: "JETPOOL 회원가입",
  alternates: { canonical: '/signup' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
