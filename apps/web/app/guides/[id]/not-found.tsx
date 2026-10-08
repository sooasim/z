import type { Metadata } from 'next';
import { NotFoundView } from '@/components/public/NotFoundView';

export const metadata: Metadata = { title: '가이드를 찾을 수 없음', robots: { index: false, follow: true } };

export default function NotFound() {
  return <NotFoundView kind="guide" />;
}
