import { arr, f, num, str } from './shape';

/** Normalised views over loosely-typed API rows. */
export function propertyView(p: any) {
  const media = arr(p, 'media', 'photos', 'images');
  const cover =
    str(p, 'coverUrl', 'coverImageUrl', 'thumbnailUrl', 'imageUrl') ||
    (media.length ? str(media[0], 'url', 'publicUrl', 'cdnUrl', 'src') || (typeof media[0] === 'string' ? (media[0] as string) : '') : '');
  return {
    id: str(p, 'id', 'propertyId'),
    slug: str(p, 'slug') || str(p, 'id'),
    title: str(p, 'title', 'name') || 'Untitled',
    city: str(p, 'city', 'address.city', 'region', 'locality', 'location.city'),
    country: str(p, 'country', 'countryCode', 'address.country'),
    priceMinor: num(p, 'nightlyPriceMinor', 'basePriceMinor', 'priceMinor', 'nightlyRateMinor', 'baseNightlyMinor', 'price.amountMinor'),
    currency: str(p, 'currency', 'price.currency') || 'KRW',
    cover,
    media: media.map((m: any) => (typeof m === 'string' ? m : str(m, 'url', 'publicUrl', 'cdnUrl', 'src'))).filter(Boolean) as string[],
    rating: num(p, 'rating', 'ratingAvg', 'avgRating', 'reputation.score'),
    reviewCount: num(p, 'reviewCount', 'reviewsCount', 'ratingCount') ?? 0,
    compliance: str(p, 'complianceStatus', 'compliance.status', 'complianceDecision', 'compliance.decision'),
    lat: num(p, 'lat', 'latitude', 'location.lat', 'geo.lat', '_geo.lat'),
    lng: num(p, 'lng', 'lon', 'longitude', 'location.lng', 'location.lon', 'geo.lng', '_geo.lng'),
    maxGuests: num(p, 'maxGuests', 'capacity', 'occupancy'),
    bedrooms: num(p, 'bedrooms'),
    bathrooms: num(p, 'bathrooms'),
    amenities: arr(p, 'amenities').map((a: any) => (typeof a === 'string' ? a : str(a, 'name', 'code', 'amenity'))),
    houseRules: f<any>(p, 'houseRules', 'rules'),
    description: str(p, 'description', 'summary'),
    status: str(p, 'status', 'state'),
    exchangeEnabled: Boolean(f(p, 'exchangeEnabled', 'allowExchange', 'isExchangeEnabled')),
    rentalEnabled: f(p, 'rentalEnabled', 'paidStayEnabled', 'allowPaidStay') !== false,
    hostId: str(p, 'hostId', 'ownerId', 'host.id'),
    host: f<any>(p, 'host'),
    cancellationPolicy: str(p, 'cancellationPolicy', 'cancellationPolicyCode', 'cancellation_policy.code'),
    propertyType: str(p, 'propertyType', 'type'),
  };
}
export type PropertyView = ReturnType<typeof propertyView>;

export function guideView(g: any) {
  return {
    id: str(g, 'id', 'guideId', 'userId'),
    name: str(g, 'displayName', 'name', 'user.displayName') || 'Guide',
    type: str(g, 'guideType', 'type', 'tier') || 'FRIEND',
    city: str(g, 'city', 'region', 'baseCity', 'location'),
    languages: arr(g, 'languages').map(String),
    bio: str(g, 'bio', 'introduction', 'about'),
    rateMinor: num(g, 'hourlyRateMinor', 'rateMinor', 'priceMinor', 'dailyRateMinor'),
    currency: str(g, 'currency') || 'KRW',
    rating: num(g, 'rating', 'ratingAvg'),
    verified: Boolean(f(g, 'verified', 'isVerified', 'verificationStatus') === true || str(g, 'verificationStatus') === 'VERIFIED'),
    avatar: str(g, 'avatarUrl', 'photoUrl'),
    interests: arr(g, 'interests', 'specialties', 'tags').map(String),
  };
}

export function productView(p: any) {
  return {
    id: str(p, 'id'),
    title: str(p, 'title', 'name') || 'Product',
    kind: str(p, 'productType', 'type', 'category') || 'TOUR',
    city: str(p, 'city', 'destination', 'region'),
    priceMinor: num(p, 'priceMinor', 'basePriceMinor', 'fromPriceMinor', 'minPriceMinor'),
    currency: str(p, 'currency') || 'KRW',
    supplier: str(p, 'supplierName', 'supplier.name', 'supplier.displayName'),
    cancellation: str(p, 'cancellationTerms', 'cancellationPolicy', 'refundPolicy'),
    cover: str(p, 'coverUrl', 'imageUrl', 'thumbnailUrl'),
    description: str(p, 'description', 'summary'),
    status: str(p, 'status'),
    durationDays: num(p, 'durationDays', 'days'),
  };
}

export const GUIDE_TYPES = ['FRIEND', 'VOLUNTEER', 'PAID', 'PROFESSIONAL'] as const;
export const GUIDE_TYPE_LABEL: Record<string, { ko: string; en: string; paid: boolean }> = {
  FRIEND: { ko: '프렌드 (무료 교류)', en: 'Friend (free)', paid: false },
  VOLUNTEER: { ko: '자원봉사', en: 'Volunteer', paid: false },
  PAID: { ko: '유료 가이드', en: 'Paid guide', paid: true },
  PROFESSIONAL: { ko: '전문 가이드', en: 'Professional', paid: true },
};
