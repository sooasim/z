import type { Metadata } from 'next';
import { Suspense } from 'react';
import { arr, str } from '@/lib/shape';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import StayDetailView from './view';

const path = (slug: string) => `/v1/properties/by-slug/${encodeURIComponent(slug)}`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data: p, status } = await probe(path(slug));
  // The page itself calls notFound(); metadata only needs the 404 title (throwing here renders an empty error shell).
  if (isMissing(status)) return { title: '숙소를 찾을 수 없음', robots: { index: false } };
  const title = str(p, 'title', 'name') || '숙소';
  const description = (str(p, 'summary', 'description') || `${title} — JETPOOL 검증 숙소`).slice(0, 160);
  // Share thumbnail: the listing's cover photo (str() cannot index arrays, so read media[0] explicitly).
  const image = str(p, 'coverUrl', 'coverImageUrl') || str(arr<any>(p, 'media')[0], 'url');
  return {
    title,
    description,
    alternates: { canonical: `/stay/${slug}` },
    openGraph: { title, description, images: image ? [image] : undefined },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await ensureExists(path(slug));
  return (
    <Suspense>
      <StayDetailView />
    </Suspense>
  );
}
