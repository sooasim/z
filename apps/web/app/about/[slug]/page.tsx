import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { str } from '@/lib/shape';
import { isMissing, probe } from '@/components/public/server';
import View from './view';

const pagePath = (slug: string) => `/v1/content/page/${encodeURIComponent(slug)}`;
const legacyPath = (slug: string) => `/v1/content/legacy/${encodeURIComponent(slug)}`;

/** A migrated wontc.co.kr page is a CMS PAGE entry; anything else from the old site is LEGACY_CONTENT. */
async function load(slug: string) {
  const page = await probe(pagePath(slug));
  if (!isMissing(page.status)) return page;
  const legacy = await probe(legacyPath(slug));
  return isMissing(legacy.status) ? { status: 404, data: null } : legacy;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data: e, status } = await load(slug);
  if (isMissing(status)) return { title: '페이지를 찾을 수 없음', robots: { index: false } };
  const title = str(e, 'seo.title', 'title') || '브랜드 이야기';
  const description = (str(e, 'seo.description', 'summary') || 'JETPOOL · 원여행클럽(WONT Travel Club) 이야기').slice(0, 160);
  const image = str(e, 'seo.og.image', 'data.heroUrl', 'data.coverUrl');
  return {
    title,
    description,
    alternates: { canonical: `/about/${slug}` },
    robots: e?.seo?.noindex ? { index: false } : undefined,
    openGraph: { type: 'article', title, description, images: image ? [image] : undefined },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await load(slug);
  if (isMissing(r.status)) notFound();
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
