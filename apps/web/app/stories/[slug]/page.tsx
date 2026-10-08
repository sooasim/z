import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { str } from '@/lib/shape';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (slug: string) => `/v1/content/story/${encodeURIComponent(slug)}`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data: s, status } = await probe(path(slug));
  if (isMissing(status)) notFound();
  const title = str(s, 'seo.title', 'title') || '스토리';
  const description = (str(s, 'seo.description', 'summary') || 'JETPOOL 스토리 — 한달살기와 홈 맞교환, 로컬 라이프 이야기').slice(0, 160);
  const image = str(s, 'data.coverUrl', 'coverUrl', 'seo.og.image');
  return { title, description, alternates: { canonical: `/stories/${slug}` }, openGraph: { type: 'article', title, description, images: image ? [image] : undefined } };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await ensureExists(path(slug));
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
