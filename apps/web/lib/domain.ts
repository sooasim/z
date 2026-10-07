import { arr, f, num, str } from './shape';

/** Normalised views over loosely-typed API rows. */
export function propertyView(p: any) {
  const media = arr(p, 'media', 'photoUrls', 'photos', 'images');
  const cover =
    str(p, 'coverUrl', 'coverImageUrl', 'thumbnailUrl', 'imageUrl') ||
    (media.length ? str(media[0], 'url', 'publicUrl', 'cdnUrl', 'src') || (typeof media[0] === 'string' ? (media[0] as string) : '') : '');
  return {
    id: str(p, 'id', 'propertyId'),
    slug: str(p, 'slug') || str(p, 'id'),
    title: str(p, 'title', 'name') || 'Untitled',
    city: str(p, 'city', 'location.city', 'location.areaLabel', 'areaLabel', 'address.city', 'region'),
    country: str(p, 'country', 'location.country', 'countryCode', 'address.country'),
    priceMinor: num(p, 'nightlyPriceMinor', 'basePriceMinor', 'priceMinor', 'nightlyRateMinor', 'baseNightlyMinor', 'price.amountMinor'),
    currency: str(p, 'currency', 'price.currency') || 'KRW',
    cover,
    media: media.map((m: any) => (typeof m === 'string' ? m : str(m, 'url', 'publicUrl', 'cdnUrl', 'src'))).filter(Boolean) as string[],
    amenityItems: arr(p, 'amenities').map((a: any) => (typeof a === 'string' ? { code: a, ko: a, en: a } : { code: str(a, 'code'), ko: str(a, 'labelKo', 'label', 'code'), en: str(a, 'labelEn', 'label', 'code') })),
    rating: num(p, 'ratingAvg', 'reputation.ratingAvg', 'rating', 'avgRating'),
    reviewCount: num(p, 'reviewCount', 'reputation.reviewCount', 'reviewsCount') ?? 0,
    compliance:
      str(p, 'compliance.decision', 'complianceStatus', 'compliance.status') ||
      (f(p, 'paidBookingEnabled') === true ? 'ALLOW' : f(p, 'paidBookingEnabled') === false && f(p, 'rentalEnabled') !== false ? 'REVIEW' : ''),
    paidBookingEnabled: f(p, 'paidBookingEnabled') === true,
    lat: num(p, 'lat', 'latitude', 'location.lat', 'geo.lat', '_geo.lat'),
    lng: num(p, 'lng', 'lon', 'longitude', 'location.lng', 'location.lon', 'geo.lng', '_geo.lng'),
    maxGuests: num(p, 'maxGuests', 'capacity', 'occupancy'),
    bedrooms: num(p, 'bedrooms'),
    bathrooms: num(p, 'bathrooms'),
    amenities: arr(p, 'amenities').map((a: any) => (typeof a === 'string' ? a : str(a, 'name', 'code', 'amenity'))),
    houseRules: f<any>(p, 'houseRules', 'rules'),
    description: str(p, 'description', 'summary'),
    summary: str(p, 'summary'),
    status: str(p, 'status', 'state'),
    exchangeEnabled: Boolean(f(p, 'exchangeEnabled', 'allowExchange', 'isExchangeEnabled')),
    rentalEnabled: f(p, 'rentalEnabled', 'paidStayEnabled', 'allowPaidStay') !== false,
    hostId: str(p, 'hostId', 'ownerId', 'host.id'),
    host: f<any>(p, 'host'),
    cancellationPolicy: str(p, 'cancellationPolicy.name', 'cancellationPolicy.code', 'cancellationPolicyCode'),
    propertyType: str(p, 'propertyType', 'type'),
  };
}
export type PropertyView = ReturnType<typeof propertyView>;

export function guideView(g: any) {
  return {
    id: str(g, 'guideId', 'id', 'userId'),
    name: str(g, 'displayName', 'name', 'user.displayName') || 'Guide',
    type: str(g, 'guideType', 'type', 'tier') || 'FRIEND',
    city: str(g, 'city', 'regions.0', 'region', 'baseCity'),
    languages: arr(g, 'languages').map(String),
    bio: str(g, 'bio', 'introduction', 'about'),
    rateMinor: num(g, 'hourlyPriceMinor', 'hourlyRateMinor', 'rateMinor', 'priceMinor'),
    headline: str(g, 'headline'),
    paidEnabled: Boolean(f(g, 'paidEnabled')),
    reviewCount: num(g, 'reviewCount') ?? 0,
    currency: str(g, 'currency') || 'KRW',
    rating: num(g, 'ratingAvg', 'rating'),
    verified: Boolean(f(g, 'verified', 'isVerified', 'verificationStatus') === true || str(g, 'verificationStatus') === 'VERIFIED'),
    avatar: str(g, 'avatarUrl', 'photoUrl'),
    interests: [...arr(g, 'interests'), ...arr(g, 'specialties')].map(String),
  };
}

export function productView(p: any) {
  return {
    id: str(p, 'id'),
    title: str(p, 'title', 'name') || 'Product',
    kind: str(p, 'type', 'productType', 'category') || 'TOUR',
    city: str(p, 'city', 'destination', 'region'),
    priceMinor: num(p, 'basePriceMinor', 'priceMinor', 'fromPriceMinor', 'minPriceMinor'),
    currency: str(p, 'currency') || 'KRW',
    supplier: str(p, 'seller.name', 'supplierName', 'supplier.name'),
    merchantOfRecord: str(p, 'seller.merchantOfRecord'),
    cancellation: typeof f(p, 'cancellationTerms') === 'string' ? str(p, 'cancellationTerms') : str(p, 'cancellationTerms.note', 'cancellationPolicy'),
    cancellationTiers: arr<any>(p, 'cancellationTerms.tiers'),
    cover: str(p, 'coverUrl', 'imageUrl', 'thumbnailUrl'),
    description: str(p, 'description', 'summary'),
    summary: str(p, 'summary'),
    status: str(p, 'status'),
    durationDays: num(p, 'durationDays', 'days') ?? (num(p, 'durationMinutes') !== undefined && num(p, 'durationMinutes')! >= 1440 ? Math.round(num(p, 'durationMinutes')! / 1440) : undefined),
    durationMinutes: num(p, 'durationMinutes'),
  };
}

export const GUIDE_TYPES = ['FRIEND', 'VOLUNTEER', 'PAID', 'PROFESSIONAL'] as const;
export const GUIDE_TYPE_LABEL: Record<string, { ko: string; en: string; paid: boolean }> = {
  FRIEND: { ko: '프렌드 (무료 교류)', en: 'Friend (free)', paid: false },
  VOLUNTEER: { ko: '자원봉사', en: 'Volunteer', paid: false },
  PAID: { ko: '유료 가이드', en: 'Paid guide', paid: true },
  PROFESSIONAL: { ko: '전문 가이드', en: 'Professional', paid: true },
};
