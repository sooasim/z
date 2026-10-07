import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, call, type TestApp } from './helpers.js';
import { CachedGeocoder, KakaoGeocoder, NominatimGeocoder, StaticGeocoder, fuzzCoordinates, haversineKm, type Geocoder } from '../src/modules/geo/geocoder.js';
import { geocode } from '../src/modules/geo/service.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('PLAT-02 geo adapter', () => {
  it('static geocoder resolves Korean cities and Seoul districts (ko/en)', async () => {
    const g = new StaticGeocoder();
    const [gangnam] = await g.geocode('서울 강남구 테헤란로 1');
    expect(gangnam).toMatchObject({ precision: 'DISTRICT', region: 'KR-11', district: 'Gangnam-gu', provider: 'STATIC' });
    expect((await g.geocode('Busan'))[0]).toMatchObject({ city: 'Busan', region: 'KR-26', precision: 'CITY' });
    expect((await g.geocode('제주'))[0]).toMatchObject({ city: 'Jeju', region: 'KR-49' });
    for (const c of ['Incheon', 'Gangneung', 'Gyeongju', 'Jeonju', 'Sokcho', 'Yeosu', 'Daegu', 'Daejeon', 'Gwangju']) {
      expect((await g.geocode(c))[0]?.city).toBe(c);
    }
    expect(await g.geocode('Atlantis')).toEqual([]);
  });

  it('reverse geocodes to the finest enclosing area, null far away', async () => {
    const g = new StaticGeocoder();
    expect((await g.reverse(37.5172, 127.0473))?.district).toBe('Gangnam-gu');
    expect((await g.reverse(35.18, 129.08))?.city).toBe('Busan');
    expect(await g.reverse(0, 0)).toBeNull();
  });

  it('HTTP endpoints + validation', async () => {
    const r = await call(t, null, 'GET', `/v1/geo/geocode?q=${encodeURIComponent('마포구')}`);
    expect(r.status).toBe(200);
    expect(r.body.items[0].district).toBe('Mapo-gu');
    const rev = await call(t, null, 'GET', '/v1/geo/reverse?lat=37.5663&lng=126.9019');
    expect(rev.body.item.district).toBe('Mapo-gu');
    expect((await call(t, null, 'GET', '/v1/geo/geocode')).status).toBe(400);
    expect((await call(t, null, 'GET', '/v1/geo/reverse?lat=200&lng=1')).status).toBe(400);
    expect((await geocode(t.app.ctx, '서울'))[0].city).toBe('Seoul');
  });

  it('fuzzes coordinates deterministically by id (~200-300m)', () => {
    const a = fuzzCoordinates('11111111-1111-1111-1111-111111111111', 37.5, 127.0);
    const b = fuzzCoordinates('11111111-1111-1111-1111-111111111111', 37.5, 127.0);
    const c = fuzzCoordinates('22222222-2222-2222-2222-222222222222', 37.5, 127.0);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const p of [a, c]) {
      const m = haversineKm(37.5, 127.0, p.lat, p.lng) * 1000;
      expect(m).toBeGreaterThan(150);
      expect(m).toBeLessThan(350);
    }
  });

  it('caches provider results and falls back to STATIC when the provider fails', async () => {
    let calls = 0;
    const flaky: Geocoder = {
      name: 'KAKAO',
      async geocode() {
        calls++;
        return [{ label: 'X', lat: 1, lng: 2, country: 'KR', precision: 'ADDRESS', provider: 'KAKAO' }];
      },
      async reverse() {
        throw new Error('down');
      },
    };
    const g = new CachedGeocoder(flaky);
    await g.geocode('abc');
    await g.geocode('ABC ');
    expect(calls).toBe(1);
    expect((await g.reverse(37.5172, 127.0473))?.provider).toBe('STATIC');
  });

  it('Kakao and Nominatim adapters call their APIs with key / User-Agent and map results', async () => {
    const seen: { url: string; headers: any }[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      seen.push({ url, headers: init.headers });
      if (url.includes('kakao') && url.includes('address.json')) {
        return new Response(JSON.stringify({ documents: [{ address_name: '서울 강남구 역삼동', x: '127.03', y: '37.50', address: { region_1depth_name: '서울', region_2depth_name: '강남구' } }] }));
      }
      return new Response(JSON.stringify([{ display_name: 'Busan', lat: '35.1', lon: '129.0', addresstype: 'city', address: { country_code: 'kr', city: 'Busan', 'ISO3166-2-lvl4': 'KR-26' } }]));
    }) as any;
    const k = new KakaoGeocoder('kkey', fakeFetch, 'https://dapi.kakao.test');
    const [kr] = await k.geocode('역삼동');
    expect(kr).toMatchObject({ lat: 37.5, lng: 127.03, region: 'KR-11', provider: 'KAKAO' });
    expect(seen[0].headers.authorization).toBe('KakaoAK kkey');
    const n = new NominatimGeocoder('JETPOOL-test/1.0', fakeFetch, 'https://nominatim.test', 50);
    const started = Date.now();
    await n.geocode('Busan');
    const [nr] = await n.geocode('Busan 2');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45); // throttled
    expect(nr).toMatchObject({ city: 'Busan', region: 'KR-26', precision: 'CITY', provider: 'NOMINATIM' });
    expect(seen.at(-1)!.headers['user-agent']).toBe('JETPOOL-test/1.0');
  });
});
