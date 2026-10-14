'use client';
/**
 * The rebuilt WON TRAVEL CLUB programme (travel_products.detail, MIG-01).
 *
 * The legacy wontc.co.kr product pages carried their fact sheet, day-by-day schedule, destination guide and hotel
 * information as baked-in images. The migration transcribed them (data/media/wont-programs.json), so this renders
 * them as real text — selectable, searchable, translatable — with the original photographs beside it. Images whose
 * information is now text are offered at the end as 원본 안내물; the ones the migration restricted are not shown.
 */
import Link from 'next/link';
import { useState } from 'react';
import { Photo, PhotoLightbox } from '@/components/media';
import { useI18n } from '@/lib/i18n';
import { placeLabel } from '@/lib/places';
import { Badge, Icon, Kv, Section } from '@/components/ui';
import s from './public.module.css';

export interface ProgramDay {
  day?: number;
  date?: string;
  place?: string;
  theme?: string;
  items?: Array<{ time?: string; text?: string; sub?: string[] }>;
  hotel?: string;
  meals?: string[];
  note?: string;
}
type Img = { url?: string; alt?: string };

const list = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** Day-by-day schedule — shared by the product page and the itinerary page. */
export function ProgramSchedule({ days, note }: { days: ProgramDay[]; note?: string }) {
  const { L } = useI18n();
  if (!days.length) return null;
  return (
    <ol className={s.progDays}>
      {days.map((d, i) => (
        <li key={i} className={s.progDay}>
          <div className={s.progDayHead}>
            <strong>{d.day === 0 ? L('사전 모임', 'Day 0') : L(`${d.day ?? i + 1}일차`, `Day ${d.day ?? i + 1}`)}</strong>
            {d.date && <span className="small muted">{d.date}</span>}
            {d.place && <span className="small muted">{d.place}</span>}
          </div>
          {d.theme && <p className={s.progTheme}>{d.theme}</p>}
          {list<NonNullable<ProgramDay['items']>[number]>(d.items).length > 0 && (
            <ul className={s.progItems}>
              {list<NonNullable<ProgramDay['items']>[number]>(d.items).map((it, j) => (
                <li key={j}>
                  {it.time && <span className={s.progTime}>{it.time}</span>}
                  <span>
                    {it.text}
                    {list<string>(it.sub).length > 0 && (
                      <span className={s.progSub}>
                        {list<string>(it.sub).map((t, k) => (
                          <span key={k}>{t}</span>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(d.hotel || list<string>(d.meals).length > 0) && (
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              {[d.hotel ? L(`숙소 · ${d.hotel}`, `Stay · ${d.hotel}`) : '', list<string>(d.meals).join(' · ')].filter(Boolean).join(' / ')}
            </p>
          )}
          {d.note && <p className="xs muted" style={{ margin: '6px 0 0' }}>{d.note}</p>}
        </li>
      ))}
      {note && (
        <li className="xs muted" style={{ listStyle: 'none' }}>
          {note}
        </li>
      )}
    </ol>
  );
}

export default function ProgramDetail({ d, productId }: { d: any; productId?: string }) {
  const { L, lang } = useI18n();
  const [lb, setLb] = useState<number | null>(null);
  if (!d || typeof d !== 'object') return null;
  const fact = d.factSheet ?? {};
  const rows: Array<[React.ReactNode, React.ReactNode]> = list<any>(fact.rows).map((r) => [
    r.label,
    <span key={r.label} className={s.progValues}>
      {list<string>(r.values).map((v, i) => (
        <span key={i}>{v}</span>
      ))}
    </span>,
  ]);
  const gallery = list<Img>(d.gallery).filter((g) => g.url);
  const docs = list<Img & { title?: string }>(d.documents).filter((g) => g.url);
  const spots = list<any>(d.spots);
  const stays = list<any>(d.stays);
  const highlights = list<any>(d.highlights);
  const companions = list<any>(d.companions);
  const withheld = list<any>(d.withheld);
  const dest = d.destination;
  // the city name is rendered through the place table, so ja/zh/vi do not fall back to the Korean label
  const destName = placeLabel(dest?.city, lang) || dest?.city || '';
  const archiveRoute = d.legacy?.archiveRoute;
  return (
    <>
      {d.lead && <p className={s.progLead}>{d.lead}</p>}
      {d.concept?.body && (
        <Section title={d.concept.title || L('기획 의도', 'The idea')}>
          <p style={{ whiteSpace: 'pre-line', lineHeight: 1.75 }}>{d.concept.body}</p>
        </Section>
      )}
      {(rows.length > 0 || list<string>(fact.includes).length > 0) && (
        <Section title={L('프로그램 개요', 'Programme at a glance')}>
          {fact.title && <p className="small muted" style={{ marginTop: 0 }}>{fact.title}</p>}
          {rows.length > 0 && <Kv rows={rows} />}
          <div className="grid-2" style={{ marginTop: 16, gap: 16 }}>
            {list<string>(fact.includes).length > 0 && (
              <div>
                <h3 className="small" style={{ margin: '0 0 8px' }}>{L('포함 사항', 'Included')}</h3>
                <ul className={s.check}>
                  {list<string>(fact.includes).map((t, i) => (
                    <li key={i}>
                      <Icon name="check-circle" size={18} style={{ color: 'var(--success)' }} /> <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {list<string>(fact.excludes).length > 0 && (
              <div>
                <h3 className="small" style={{ margin: '0 0 8px' }}>{L('불포함 사항', 'Not included')}</h3>
                <ul className={s.check}>
                  {list<string>(fact.excludes).map((t, i) => (
                    <li key={i}>
                      <Icon name="info" size={18} style={{ color: 'var(--text-muted)' }} /> <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {list<string>(fact.perks).length > 0 && (
            <>
              <h3 className="small" style={{ margin: '16px 0 8px' }}>{L('특전', 'Highlights of the package')}</h3>
              <ul className={s.check}>
                {list<string>(fact.perks).map((t, i) => (
                  <li key={i}>
                    <Icon name="sparkle" size={18} style={{ color: 'var(--accent)' }} /> <span>{t}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {fact.priceNote && <p className="xs muted" style={{ marginTop: 12 }}>{fact.priceNote}</p>}
          {(fact.organiser || fact.contact) && (
            <p className="xs muted" style={{ marginTop: 8 }}>
              {[fact.organiser, fact.contact].filter(Boolean).join(' · ')}
            </p>
          )}
        </Section>
      )}
      {list<any>(d.features).length > 0 && (
        <Section title={L('프로그램 구성', 'What the programme does')}>
          <div className="grid">
            {list<any>(d.features).map((f, i) => (
              <article key={i} className="card stack" style={{ gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>{f.title}</h3>
                <ul className={s.progBullets}>
                  {list<string>(f.items).map((t, j) => (
                    <li key={j}>{t}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </Section>
      )}
      {highlights.length > 0 && (
        <Section title={L('하이라이트', 'Highlights')}>
          <div className="grid">
            {highlights.map((h, i) => (
              <article key={i} className="lcard">
                {h.photo && (
                  <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: 'var(--r-md) var(--r-md) 0 0' }}>
                    <Photo src={h.photo} alt={h.alt || ''} sizes="(max-width: 640px) 92vw, 320px" />
                  </div>
                )}
                <div className="body" style={{ gap: 4 }}>
                  <h3 className="lcard-title" style={{ margin: 0 }}>{h.title}</h3>
                  {h.note && <p className="small muted" style={{ margin: 0 }}>{h.note}</p>}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}
      {list<ProgramDay>(d.schedule?.days).length > 0 && (
        <Section title={L('여행 일정', 'Day by day')} actions={productId ? <Link className="small" href={`/travel/${productId}/itinerary`}>{L('일정표만 보기', 'Itinerary only')}</Link> : undefined}>
          <ProgramSchedule days={list<ProgramDay>(d.schedule.days)} note={d.schedule.note} />
        </Section>
      )}
      {spots.length > 0 && (
        <Section title={L('관광 정보', 'Places you visit')} id="spots">
          <div className="stack" style={{ gap: 20 }}>
            {spots.map((p, i) => (
              <article key={i} className={s.progSpot}>
                {p.photo && (
                  <div className={s.progSpotPhoto}>
                    <Photo src={p.photo} alt={p.name || ''} sizes="(max-width: 760px) 92vw, 300px" />
                  </div>
                )}
                <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                  <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>
                    {p.name} {p.nameEn && <span className="small muted">{p.nameEn}</span>}
                  </h3>
                  {p.city && <p className="xs muted" style={{ margin: 0 }}>{[p.region, p.city].filter(Boolean).join(' · ')}</p>}
                  {p.lead && <p className="small" style={{ margin: 0, fontWeight: 600 }}>{p.lead}</p>}
                  {p.body && <p className="small" style={{ margin: 0, lineHeight: 1.7 }}>{p.body}</p>}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}
      {stays.length > 0 && (
        <Section title={L('숙소', 'Where you stay')}>
          {stays.map((h, i) => (
            <article key={i} className="card stack">
              <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>
                {h.name} {h.nameEn && <span className="small muted">{h.nameEn}</span>}
              </h3>
              {h.lead && <p className="small" style={{ margin: 0, fontWeight: 600 }}>{h.lead}</p>}
              {h.body && <p className="small" style={{ margin: 0, lineHeight: 1.7 }}>{h.body}</p>}
              {(h.address || h.phone) && (
                <p className="xs muted" style={{ margin: 0 }}>{[h.address, h.phone].filter(Boolean).join(' · ')}</p>
              )}
              {list<string>(h.photos).length > 0 && (
                <div className={s.progStrip}>
                  {list<string>(h.photos).map((src, j) => (
                    <div key={j} className={s.progStripItem}>
                      <Photo src={src} alt="" sizes="200px" />
                    </div>
                  ))}
                </div>
              )}
              {h.dining && (
                <div className="stack" style={{ gap: 6 }}>
                  {h.dining.title && <strong className="small">{h.dining.title}</strong>}
                  {h.dining.body && <p className="small" style={{ margin: 0, lineHeight: 1.7 }}>{h.dining.body}</p>}
                  {h.dining.allergyNote && <p className="xs muted" style={{ margin: 0 }}>{h.dining.allergyNote}</p>}
                </div>
              )}
            </article>
          ))}
        </Section>
      )}
      {companions.length > 0 && (
        <Section title={L('함께하는 사람', 'Who travels with you')}>
          <div className="stack" style={{ gap: 16 }}>
            {companions.map((c, i) => (
              <article key={i} className={s.progSpot}>
                {c.photo && (
                  <div className={s.progSpotPhoto}>
                    <Photo src={c.photo} alt={c.name || ''} sizes="(max-width: 760px) 92vw, 300px" />
                  </div>
                )}
                <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                  {c.role && <Badge tone="info">{c.role}</Badge>}
                  <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>{c.name}</h3>
                  {c.title && <p className="small muted" style={{ margin: 0 }}>{c.title}</p>}
                  {c.bio && <p className="small" style={{ margin: 0, lineHeight: 1.7 }}>{c.bio}</p>}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}
      {(d.route?.photo || d.route?.note) && (
        <Section title={L('여행 루트', 'Route')}>
          {d.route.note && <p className="small" style={{ marginTop: 0 }}>{d.route.note}</p>}
          {d.route.photo && (
            <div style={{ borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
              <Photo src={d.route.photo} alt={L('여행 동선 지도', 'Route map')} sizes="(max-width: 900px) 92vw, 720px" />
            </div>
          )}
        </Section>
      )}
      {dest?.body && (
        <Section title={L(`${destName} 도시 정보`, `About ${destName}`)}>
          {dest.lead && <p className="small" style={{ marginTop: 0, fontWeight: 600 }}>{dest.lead}</p>}
          <p style={{ whiteSpace: 'pre-line', lineHeight: 1.75 }}>{dest.body}</p>
          {list<any>(dest.facts).length > 0 && <Kv rows={list<any>(dest.facts).map((f) => [f.label, f.value] as [React.ReactNode, React.ReactNode])} />}
        </Section>
      )}
      {gallery.length > 0 && (
        <Section title={L('사진', 'Photos')}>
          <div className="grid">
            {gallery.map((g, i) => (
              <button key={i} type="button" className={s.progPhoto} onClick={() => setLb(i)} aria-label={g.alt || L('사진 크게 보기', 'Open photo')}>
                <Photo src={g.url!} alt={g.alt || ''} sizes="(max-width: 640px) 92vw, 320px" />
              </button>
            ))}
          </div>
          {lb !== null && <PhotoLightbox items={gallery.map((g) => ({ src: g.url!, alt: g.alt || '' }))} index={lb} onClose={() => setLb(null)} />}
        </Section>
      )}
      {(docs.length > 0 || withheld.length > 0) && (
        <Section title={L('원본 안내물', 'Original programme sheets')}>
          <p className="small muted" style={{ marginTop: 0 }}>
            {L('원여행클럽 사이트가 이미지로 싣던 안내물입니다. 위의 내용은 이 이미지들을 그대로 옮긴 것이에요.', 'The sheets the original site published as images. Everything above is transcribed from them.')}
          </p>
          {docs.length > 0 && (
            <div className={s.progStrip}>
              {docs.map((g, i) => (
                <figure key={i} className={s.progDoc}>
                  <Photo src={g.url!} alt={g.alt || ''} sizes="260px" />
                  {g.title && <figcaption className="xs muted">{g.title}</figcaption>}
                </figure>
              ))}
            </div>
          )}
          {withheld.length > 0 && (
            <ul className="xs muted" style={{ margin: '12px 0 0', paddingLeft: 18 }}>
              {withheld.map((w, i) => (
                <li key={i}>{w.reason}</li>
              ))}
            </ul>
          )}
          {archiveRoute && (
            <p className="small" style={{ marginTop: 12 }}>
              <Link href={archiveRoute}>{L('원본 페이지 보관본 보기 →', 'See the archived original page →')}</Link>
            </p>
          )}
        </Section>
      )}
    </>
  );
}
