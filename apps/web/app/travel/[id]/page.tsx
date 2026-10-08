import type { Metadata } from 'next';
import { Suspense } from 'react';
import { str } from '@/lib/shape';
import { ensureExists, isMissing, probe, sharePhoto } from '@/components/public/server';
import View from './view';

const path = (id: string) => `/v1/travel-products/${encodeURIComponent(id)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { data: p, status } = await probe(path(id));
  // The page itself calls notFound(); metadata only needs the 404 title (throwing here renders an empty error shell).
  if (isMissing(status, true)) return { title: '여행 상품을 찾을 수 없음', robots: { index: false } };
  const title = str(p, 'title', 'name') || '여행 상품';
  const description = (str(p, 'summary', 'description') || `${title} — JETPOOL 투어·티켓`).slice(0, 160);
  const image = str(p, 'coverUrl', 'imageUrl') || (await sharePhoto('product', id));
  return { title, description, alternates: { canonical: `/travel/${id}` }, openGraph: { title, description, images: image ? [image] : undefined } };
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
