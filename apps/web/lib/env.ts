export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
/** Server-side origin for BFF/middleware calls (may be an internal hostname). */
export const API_INTERNAL_URL = (process.env.API_INTERNAL_URL || API_URL).replace(/\/$/, '');
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
