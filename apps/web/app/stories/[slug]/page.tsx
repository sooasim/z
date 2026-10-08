import type { Metadata } from 'next';
import { Suspense } from 'react';
import { str } from '@/lib/shape';
import { notFound } from 'next/navigation';
import { isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (slug: string) => `/v1/content/story/${encodeURIComponent(slug)}`;
/** Migrated wontc.co.kr content that is not a story (past tours, the old home page …) is LEGACY_CONTENT at /stories/<slug>. */
const legacyPath = (slug: string) => `/v1/content/legacy/${encodeURIComponent(slug)}`;

async function load(slug: string) {
  const story = await probe(path(slug));
  if (!isMissing(story.status)) return story;
  const legacy = await probe(legacyPath(slug));
  return isMissing(legacy.status) ? { status: 404, data: null } : legacy;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data: s, status } = await load(slug);
  // The page itself calls notFound(); metadata only needs the 404 title (throwing here renders an empty error shell).
  if (isMissing(status)) return { title: '스토리를 찾을 수 없음', robots: { index: false } };
  const title = str(s, 'seo.title', 'title') || '스토리';
  const description = (str(s, 'seo.description', 'summary') || 'JETPOOL 스토리 — 한달살기와 홈 맞교환, 로컬 라이프 이야기').slice(0, 160);
  const image = str(s, 'seo.og.image', 'data.heroUrl', 'data.coverUrl', 'coverUrl');
  return { title, description, alternates: { canonical: `/stories/${slug}` }, openGraph: { type: 'article', title, description, images: image ? [image] : undefined } };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (isMissing((await load(slug)).status)) notFound();
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
