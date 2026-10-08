import type { Metadata } from 'next';
import { Suspense } from 'react';
import { str } from '@/lib/shape';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (id: string) => `/v1/travel-products/${encodeURIComponent(id)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { data: p, status } = await probe(path(id));
  // The page itself calls notFound(); metadata only needs the 404 title (throwing here renders an empty error shell).
  if (isMissing(status, true)) return { title: '여행 상품을 찾을 수 없음', robots: { index: false } };
  const name = str(p, 'title', 'name');
  return { title: name ? `${name} 일정표` : '여행 일정표', description: name ? `${name} — 일정과 출발일` : '상품 일정', alternates: { canonical: `/travel/${id}/itinerary` } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureExists(path(id), true);
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
