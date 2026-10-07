import type { Metadata } from 'next';
import { Suspense } from 'react';
import { serverGet } from '@/lib/api';
import { item, str } from '@/lib/shape';
import StayDetailView from './view';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const res = await serverGet<any>(`/v1/properties/by-slug/${encodeURIComponent(slug)}`, { revalidate: 300, timeoutMs: 1500 });
  const p = item(res);
  const title = str(p, 'title', 'name') || '숙소';
  const description = (str(p, 'description', 'summary') || `${title} — JETPOOL 검증 숙소`).slice(0, 160);
  const image = str(p, 'coverUrl', 'coverImageUrl');
  return {
    title,
    description,
    alternates: { canonical: `/stay/${slug}` },
    openGraph: { title, description, images: image ? [image] : undefined },
  };
}

export default function Page() {
  return (
    <Suspense>
      <StayDetailView />
    </Suspense>
  );
}
