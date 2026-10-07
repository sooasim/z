import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "계정 보안",
  description: "MFA, 비밀번호, 연결 계정, 세션",
  alternates: { canonical: '/account/security' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
