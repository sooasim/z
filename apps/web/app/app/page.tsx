import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '앱으로 접속',
  description: 'JETPOOL 앱 화면으로 접속합니다.',
  // The manifest's start_url: a launcher, not a page anyone should reach from search.
  robots: { index: false, follow: false },
  alternates: { canonical: '/app' },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
