import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "스토리",
  description: "JETPOOL 스토리",
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
