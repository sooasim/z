import { ImageResponse } from 'next/og';

/**
 * Site-wide share card (og:image / twitter:image), rendered once at build time into a real PNG — SVG is not
 * accepted by Facebook, X, LinkedIn, Slack or KakaoTalk. English copy, taken from the home hero, because the
 * card is what links shared outside Korea show.
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

const bold = (color: string, px = 1) => `${px}px 0 0 ${color}, -${px}px 0 0 ${color}, 0 ${px}px 0 ${color}, 0 -${px}px 0 ${color}`;
const PILLS = ['Stays', 'Home Exchange', 'Guide Friends', 'Charter'];
const fill = { position: 'absolute' as const, top: 0, left: 0, width: '100%', height: '100%', display: 'flex' };

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', backgroundColor: '#0a1f36', color: '#ffffff' }}>
        {/* The site's --hero-grad: navy base, coral glow top-right, navy glow bottom-left. */}
        <div style={{ ...fill, backgroundImage: 'linear-gradient(160deg, #0e2a47 0%, #0a1f36 55%, #071526 100%)' }} />
        <div style={{ ...fill, backgroundImage: 'radial-gradient(820px 520px at 92% -6%, rgba(239,106,79,0.85), rgba(239,106,79,0) 65%)' }} />
        <div style={{ ...fill, backgroundImage: 'radial-gradient(700px 500px at 2% 112%, rgba(43,98,150,0.95), rgba(43,98,150,0) 62%)' }} />
        <div style={{ position: 'absolute', top: -186, right: -150, width: 540, height: 540, borderRadius: 540, border: '2px solid rgba(255,255,255,0.20)', display: 'flex' }} />
        <div style={{ position: 'absolute', bottom: -230, left: -120, width: 460, height: 460, borderRadius: 460, border: '2px solid rgba(255,255,255,0.10)', display: 'flex' }} />

        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', height: '100%', padding: '62px 72px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ width: 42, height: 42, marginRight: 16, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundImage: 'linear-gradient(135deg, #ef6a4f, #d94a33)' }}>
                <div style={{ width: 15, height: 15, borderRadius: 15, backgroundColor: '#ffffff', display: 'flex' }} />
              </div>
              <div style={{ display: 'flex', fontSize: 38, letterSpacing: '0.17em', textShadow: bold('#ffffff', 1) }}>JETPOOL</div>
            </div>
            <div style={{ display: 'flex', fontSize: 19, letterSpacing: '0.24em', color: 'rgba(253,230,223,0.92)' }}>TRAVEL LIKE A LOCAL</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', flexDirection: 'column', fontSize: 86, lineHeight: 1.08, letterSpacing: '-0.035em', textShadow: bold('#ffffff', 1.3) }}>
              <div style={{ display: 'flex' }}>Live a month</div>
              <div style={{ display: 'flex' }}>somewhere new.</div>
            </div>
            <div style={{ display: 'flex', marginTop: 26, maxWidth: 780, fontSize: 29, lineHeight: 1.42, color: 'rgba(226,236,245,0.9)' }}>
              Verified stays, month-long home exchanges, local guide friends and shared charter flights.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {PILLS.map((p) => (
                <div
                  key={p}
                  style={{ display: 'flex', marginRight: 12, padding: '11px 22px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.30)', backgroundColor: 'rgba(255,255,255,0.09)', fontSize: 23, color: '#ffffff' }}
                >
                  {p}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', fontSize: 20, color: 'rgba(226,236,245,0.62)' }}>WONT Travel Club is now JETPOOL</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
