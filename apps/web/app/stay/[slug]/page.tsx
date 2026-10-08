import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { str } from '@/lib/shape';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import StayDetailView from './view';

const path = (slug: string) => `/v1/properties/by-slug/${encodeURIComponent(slug)}`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data: p, status } = await probe(path(slug));
  if (isMissing(status)) notFound();
  const title = str(p, 'title', 'name') || '숙소';
  const description = (str(p, 'summary', 'description') || `${title} — JETPOOL 검증 숙소`).slice(0, 160);
  const image = str(p, 'coverUrl', 'coverImageUrl', 'media.0.url');
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
