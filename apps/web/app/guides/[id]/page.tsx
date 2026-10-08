import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { str } from '@/lib/shape';
import { placeLabel } from '@/lib/places';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (id: string) => `/v1/guides/${encodeURIComponent(id)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { data: g, status } = await probe(path(id));
  if (isMissing(status, true)) notFound();
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
