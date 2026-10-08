import type { Metadata } from 'next';
import { Suspense } from 'react';
import { str } from '@/lib/shape';
import { placeLabel } from '@/lib/places';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (id: string) => `/v1/guides/${encodeURIComponent(id)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { data: g, status } = await probe(path(id));
  // The page itself calls notFound(); metadata only needs the 404 title (throwing here renders an empty error shell).
  if (isMissing(status, true)) return { title: '가이드를 찾을 수 없음', robots: { index: false } };
  const name = str(g, 'displayName', 'name');
  const city = placeLabel(str(g, 'city'), 'ko');
  const title = name ? `${name}${city ? ` · ${city} 가이드` : ' · 가이드'}` : '가이드 프로필';
  const description = (str(g, 'headline') || str(g, 'bio') || '로컬 가이드 프렌드와 함께 걷는 여행').slice(0, 160);
  return { title, description, alternates: { canonical: `/guides/${id}` }, openGraph: { title, description } };
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
