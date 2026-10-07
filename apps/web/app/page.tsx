import type { Metadata } from 'next';
import HomeView from './view';

export const metadata: Metadata = {
  title: { absolute: 'JETPOOL — 숙소 · 홈 맞교환 · 가이드 프렌드 · 여행' },
  alternates: { canonical: '/' },
};

export default function Page() {
  return <HomeView />;
}
