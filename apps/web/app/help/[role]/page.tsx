import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ROLE_GUIDES, roleBySlug } from '@/lib/roles';
import View from './view';

/** The guide is static content, so every role page prerenders — including in the static demo export. */
export function generateStaticParams() {
  return ROLE_GUIDES.map((g) => ({ role: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ role: string }> }): Promise<Metadata> {
  const { role } = await params;
  const g = roleBySlug(role);
  if (!g) return { title: '사용 안내를 찾을 수 없음', robots: { index: false } };
  const title = `${g.name[0]} 사용 안내`;
  const description = `${g.tagline[0]} ${g.name[0]} 계정으로 열리는 화면과 각 버튼의 역할을 설명합니다.`;
  return { title, description, alternates: { canonical: `/help/${g.slug}` }, openGraph: { type: 'article', title, description } };
}

export default async function Page({ params }: { params: Promise<{ role: string }> }) {
  const { role } = await params;
  if (!roleBySlug(role)) notFound();
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
