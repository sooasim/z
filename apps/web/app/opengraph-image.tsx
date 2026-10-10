import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ImageResponse } from 'next/og';

/**
 * Site-wide share card (og:image / twitter:image), rendered once at build time into a real PNG — SVG is not
 * accepted by Facebook, X, LinkedIn, Slack or KakaoTalk. English copy, taken from the home hero, because the
 * card is what links shared outside Korea show.
 *
 * Artwork is the brand lockup (public/brand) over JETPOOL's own travel photography: the originals migrated
 * from wontc.co.kr under public/legacy, which carry no third-party credit (unlike the CC-licensed photos in
 * public/photos, which would need the attribution the /credits page gives them).
 *
 * @vercel/og ships a single Latin face (Noto Sans regular) and satori does not synthesise weights, so display
 * type is thickened with a symmetric text shadow instead of fontWeight.
 */
export const alt = 'JETPOOL — live a month somewhere new: verified stays, month-long home exchanges, local guide friends and shared charter flights';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Required by the GitHub Pages demo (`output: 'export'`), which refuses to collect an image route without it.
// scripts/pages/build.mjs strips route-segment config from its copy of app/, so it re-adds this line there.
export const dynamic = 'force-static';

/**
 * Inlined as a data URL: the renderer has no server to fetch `/legacy/…` from at build time, and it decodes
 * PNG/JPEG only — the WebP ladder next to these originals makes it throw. `rel` stays relative to public/ on
 * purpose: a leading slash would be rewritten to `/<basePath>/…` by scripts/pages/build.mjs and stop resolving.
 */
function asset(rel: string, mime: 'image/jpeg' | 'image/png'): string {
  try {
    return `data:${mime};base64,${readFileSync(path.join(process.cwd(), 'public', rel)).toString('base64')}`;
  } catch {
    return ''; // a missing asset degrades to the gradient rather than failing the build
  }
}

const LOGO = asset('brand/jetpool-logo-dark.png', 'image/png'); // light lockup, for the dark photo
const BACKDROP = asset('legacy/2f6fa2db59f8/original.jpg', 'image/jpeg'); // sunset terminal, departing jet
const CARDS = [
  { src: asset('legacy/13779e26d836/original.jpg', 'image/jpeg'), label: 'Bali', rotate: -5 },
  { src: asset('legacy/486bd1c54129/original.jpg', 'image/jpeg'), label: 'Niagara', rotate: 3 },
  { src: asset('legacy/a8ec33054412/original.jpg', 'image/jpeg'), label: 'Dubrovnik', rotate: -2 },
].filter((c) => c.src);

const bold = (color: string, px = 1) => `${px}px 0 0 ${color}, -${px}px 0 0 ${color}, 0 ${px}px 0 ${color}, 0 -${px}px 0 ${color}`;
const PILLS = ['Stays', 'Home Exchange', 'Guide Friends', 'Charter'];
const fill = { position: 'absolute' as const, top: 0, left: 0, width: '100%', height: '100%', display: 'flex' };

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', backgroundColor: '#071526', color: '#ffffff' }}>
        {BACKDROP ? <img src={BACKDROP} width={1200} height={672} style={{ ...fill, objectFit: 'cover' }} alt="" /> : null}
        {/* Navy scrim so the type stays legible over the photo, warm where the sunset is. */}
        <div style={{ ...fill, backgroundImage: 'linear-gradient(98deg, rgba(7,21,38,0.96) 0%, rgba(7,21,38,0.88) 36%, rgba(7,21,38,0.34) 62%, rgba(7,21,38,0.28) 100%)' }} />
        <div style={{ ...fill, backgroundImage: 'linear-gradient(0deg, rgba(7,21,38,0.86) 0%, rgba(7,21,38,0.1) 36%, rgba(7,21,38,0) 54%)' }} />
        <div style={{ ...fill, backgroundImage: 'radial-gradient(780px 440px at 86% 2%, rgba(239,106,79,0.5), rgba(239,106,79,0) 68%)' }} />

        {/* Three of the club's own trips, stacked like postcards over the runway. */}
        <div style={{ position: 'absolute', top: 206, right: 58, display: 'flex', alignItems: 'center' }}>
          {CARDS.map((c) => (
            <div
              key={c.label}
              style={{
                display: 'flex',
                width: 148,
                height: 188,
                marginLeft: -14,
                padding: 7,
                borderRadius: 16,
                backgroundColor: 'rgba(255,255,255,0.94)',
                boxShadow: '0 18px 40px rgba(4,12,22,0.55)',
                transform: `rotate(${c.rotate}deg)`,
              }}
            >
              <img src={c.src} width={134} height={174} style={{ width: 134, height: 174, objectFit: 'cover', borderRadius: 10 }} alt="" />
            </div>
          ))}
        </div>

        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', height: '100%', padding: '56px 72px 58px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {LOGO ? <img src={LOGO} width={272} height={111} style={{ width: 272, height: 111 }} alt="JETPOOL" /> : <div style={{ display: 'flex', fontSize: 38, letterSpacing: '0.17em', textShadow: bold('#ffffff', 1) }}>JETPOOL</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 19, letterSpacing: '0.24em', color: 'rgba(253,230,223,0.95)', marginBottom: 20 }}>TRAVEL LIKE A LOCAL</div>
            <div style={{ display: 'flex', flexDirection: 'column', fontSize: 82, lineHeight: 1.08, letterSpacing: '-0.035em', textShadow: bold('#ffffff', 1.3) }}>
              <div style={{ display: 'flex' }}>Live a month</div>
              <div style={{ display: 'flex' }}>somewhere new.</div>
            </div>
            <div style={{ display: 'flex', marginTop: 22, maxWidth: 620, fontSize: 27, lineHeight: 1.4, color: 'rgba(226,236,245,0.92)' }}>
              Verified stays, month-long home exchanges, local guide friends and shared charter flights.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center' }}>
            {PILLS.map((p) => (
              <div
                key={p}
                style={{ display: 'flex', marginRight: 10, padding: '10px 20px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.34)', backgroundColor: 'rgba(7,21,38,0.45)', fontSize: 22, color: '#ffffff' }}
              >
                {p}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
