import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { str } from '@/lib/shape';
import { ensureExists, isMissing, probe } from '@/components/public/server';
import View from './view';

const path = (id: string) => `/v1/travel-products/${encodeURIComponent(id)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { data: p, status } = await probe(path(id));
  if (isMissing(status, true)) notFound();
  const title = str(p, 'title', 'name') || '여행 상품';
  const description = (str(p, 'summary', 'description') || `${title} — JETPOOL 투어·티켓`).slice(0, 160);
  const image = str(p, 'coverUrl', 'imageUrl');
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
