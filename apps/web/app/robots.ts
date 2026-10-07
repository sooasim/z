import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/stay', '/exchange', '/guide-friends', '/travel', '/jetpool-charter', '/discover', '/stories'],
        disallow: ['/admin', '/account', '/api/', '/checkout', '/trips', '/messages', '/host', '/guide/', '/supplier', '/payments', '/earnings', '/auth/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
