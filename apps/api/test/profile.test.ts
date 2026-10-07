import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let user: TestUser, other: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  user = await createUser(t);
  other = await createUser(t);
});
afterAll(async () => t.close());

describe('CORE-02 profile', () => {
  it('reads defaults and patches profile fields; audited without PII values; profile.updated emitted', async () => {
    const g = await call(t, user, 'GET', '/v1/me/profile');
    expect(g.status).toBe(200);
    expect(g.body.item.timezone).toBe('Asia/Seoul');
    const p = await call(t, user, 'PATCH', '/v1/me/profile', {
      displayName: 'Jin',
      phone: '+821099998888',
      legalName: 'Kim Jin',
      bio: 'Traveller',
      timezone: 'Europe/Paris',
      languages: ['ko', 'en'],
      country: 'KR',
      birthYear: 1990,
      accessibility: { stepFree: true },
    });
    expect(p.status).toBe(200);
    expect(p.body.item).toMatchObject({ displayName: 'Jin', phone: '+821099998888', legalName: 'Kim Jin', timezone: 'Europe/Paris', languages: ['ko', 'en'], phoneVerified: false });
    const { rows } = await t.pool.query(`SELECT before_state, after_state, category FROM audit_logs WHERE action = 'profile.updated' AND resource_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('PRIVACY');
    expect(JSON.stringify(rows[0])).not.toContain('Kim Jin');
    expect(JSON.stringify(rows[0])).not.toContain('99998888');
    expect(rows[0].after_state.bio).toBe('Traveller');
    const { rows: ev } = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'profile.updated' AND aggregate_id = $1`, [user.id]);
    expect(ev[0].payload.fields).toEqual(expect.arrayContaining(['displayName', 'phone', 'legalName', 'timezone']));
    // no-op patch neither audits nor emits
    await call(t, user, 'PATCH', '/v1/me/profile', { displayName: 'Jin' });
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'profile.updated' AND aggregate_id = $1`, [user.id])).rows[0].n).toBe(1);
  });

  it('validates input', async () => {
    expect((await call(t, user, 'PATCH', '/v1/me/profile', { timezone: 'Mars/Olympus' })).body.code).toBe('INVALID_TIMEZONE');
    expect((await call(t, user, 'PATCH', '/v1/me/profile', { birthYear: 2025 })).body.code).toBe('INVALID_BIRTH_YEAR');
    expect((await call(t, user, 'PATCH', '/v1/me/profile', { phone: 'abc' })).status).toBe(400);
    expect((await call(t, user, 'PATCH', '/v1/me/profile', { unknownField: 1 })).status).toBe(400);
    expect((await call(t, null, 'PATCH', '/v1/me/profile', { bio: 'x' })).status).toBe(401);
  });

  it('avatar media must be owned by the user', async () => {
    const { rows } = await t.pool.query(`INSERT INTO media_assets(owner_id, storage_key, mime_type, byte_size, purpose, status) VALUES ($1,'a/1','image/png',10,'AVATAR','READY') RETURNING id`, [other.id]);
    expect((await call(t, user, 'PATCH', '/v1/me/profile', { avatarMediaId: rows[0].id })).body.code).toBe('MEDIA_NOT_OWNED');
    expect((await call(t, other, 'PATCH', '/v1/me/profile', { avatarMediaId: rows[0].id })).body.item.avatarMediaId).toBe(rows[0].id);
  });

  it('public profile exposes no contact data', async () => {
    const r = await call(t, null, 'GET', `/v1/users/${user.id}/profile`);
    expect(r.status).toBe(200);
    expect(r.body.item.displayName).toBe('Jin');
    expect(JSON.stringify(r.body)).not.toContain('+8210');
    expect(JSON.stringify(r.body)).not.toContain('@');
  });
});

describe('CORE-02 preferences', () => {
  it('patches preferences; marketing opt-in records a versioned MARKETING consent', async () => {
    const g = await call(t, user, 'GET', '/v1/me/preferences');
    expect(g.body.item.currency).toBe('KRW');
    const p = await call(t, user, 'PATCH', '/v1/me/preferences', { currency: 'USD', travelStyles: ['slow', 'food'], marketingOptIn: true });
    expect(p.body.item).toMatchObject({ currency: 'USD', travelStyles: ['slow', 'food'], marketingOptIn: true });
    const { rows } = await t.pool.query(`SELECT consent_type, granted, evidence FROM consent_records WHERE user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consent_type: 'MARKETING', granted: true });
    expect(rows[0].evidence.source).toBe('PREFERENCES');
    const off = await call(t, user, 'PATCH', '/v1/me/preferences', { marketingOptIn: false });
    expect(off.body.item.marketingOptIn).toBe(false);
    expect((await call(t, user, 'PATCH', '/v1/me/preferences', { currency: 'XYZ' })).status).toBe(400);
  });
});
