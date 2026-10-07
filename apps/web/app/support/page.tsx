import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "고객센터",
  description: "자주 묻는 질문과 문의",
  alternates: { canonical: '/support' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
