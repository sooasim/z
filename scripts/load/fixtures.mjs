#!/usr/bin/env node
// Load-test fixtures (G6). Creates N guest users with sessions + a host + one PUBLISHED, rental-enabled
// property directly in PostgreSQL, and mints access tokens with the API's JWT settings.
// NEVER run against production. Usage: DATABASE_URL=... JWT_SECRET=... node scripts/load/fixtures.mjs [guests=60] > fixture.json
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api/package.json');
const require = createRequire(apiPkg);
const pg = require('pg');
const { SignJWT } = await import(require.resolve('jose'));

if (/prod/i.test(process.env.NODE_ENV ?? '') || /prod/i.test(process.env.DATABASE_URL ?? '')) {
  console.error('refusing to create load fixtures in a production-like environment'); process.exit(2);
}
const N = Number(process.argv[2] ?? 60);
const secret = process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789';
const issuer = process.env.JWT_ISSUER ?? 'jetpool';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool' });
await db.connect();
const run = randomBytes(4).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function user(label) {
  const { rows } = await db.query(
    `INSERT INTO users(email, password_hash, display_name, email_verified_at, identity_verified_at)
     VALUES ($1, 'x-load-fixture-no-login', $2, now(), now()) RETURNING id`,
    [`load_${run}_${label}@load.jetpool.test`, `load ${label}`]);
  const id = rows[0].id;
  const s = await db.query(`INSERT INTO sessions(user_id, refresh_token_hash, aal, expires_at) VALUES ($1,$2,'aal1', now() + interval '1 day') RETURNING id`,
    [id, sha(randomBytes(16).toString('hex'))]);
  const token = await new SignJWT({ sid: s.rows[0].id, aal: 'aal1' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(id).setIssuer(issuer).setIssuedAt().setExpirationTime('2h').sign(new TextEncoder().encode(secret));
  return { id, token };
}

// Placing a hold passes two gates that a freshly migrated database leaves shut, and only the dev seed opens:
// the platform feature flag (migration 0007 ships it disabled) and compliance, which refuses a paid booking
// on a property no APPROVED rule covers (NO_APPROVED_RULE -> REVIEW -> 403). The G6 job migrates without
// seeding, so without both of these every hold in the race answers 403, the race never happens, and the
// no-oversell check has nothing to look at. They belong to the fixture for the same reason the property
// does: this script's job is a database the load scenario can actually run against. Neither gate is relaxed
// for the run — the scenario satisfies them the way a real deployment does.
const flagged = await db.query(`UPDATE feature_flags SET enabled = true WHERE flag_key = 'stay.paid_booking' RETURNING flag_key`);
if (flagged.rowCount !== 1) {
  console.error(`expected to enable feature flag stay.paid_booking, updated ${flagged.rowCount} rows — is the database migrated?`);
  process.exit(2);
}

// The rule the fixture property is judged against: KR, every listing type, no permit required, so compliance
// answers ALLOW without the fixture also having to mint verified permits. Approved by its own throwaway user
// rather than a seeded admin, since the suite runs against a database that may only have been migrated.
const approver = await user('compliance-approver');
await db.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,'ADMIN') ON CONFLICT DO NOTHING`, [approver.id]);
await db.query(
  `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, applies_to, required_permit_types,
                               effective_from, status, approved_by, approved_at, created_by, note)
   VALUES ($1,'PROPERTY','KR','{}'::jsonb,'{}'::text[], current_date - 1, 'APPROVED', $2, now(), $2,
           'G6 load fixture — not a legally approved rule; this database is for load testing only')`,
  [`load-${run}-kr-stay`, approver.id],
);

const host = await user('host');
await db.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,'HOST') ON CONFLICT DO NOTHING`, [host.id]);
// A hold snapshots the property's cancellation policy and refuses to exist without one
// (CANCELLATION_POLICY_REQUIRED, 422), so the fixture picks one of the reference policies migration 0007
// installs rather than leaving the column null.
const { rows: [policy] } = await db.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`);
if (!policy) { console.error('no MODERATE cancellation policy — is the database migrated?'); process.exit(2); }
const { rows: [prop] } = await db.query(
  `INSERT INTO properties(host_id, slug, title, property_type, max_guests, city, region, lat, lng, rental_enabled, instant_book,
                          base_price_minor, currency, status, paid_booking_enabled, cancellation_policy_id, published_at)
   VALUES ($1, $2, 'Load test stay', 'APARTMENT', 4, 'Seoul', 'Seoul', 37.5665, 126.9780, true, true, 100000, 'KRW', 'PUBLISHED', true, $3, now())
   RETURNING id`, [host.id, `load-${run}`, policy.id]);
const guests = [];
for (let i = 0; i < N; i++) guests.push((await user(`g${i}`)).token);
await db.end();
process.stdout.write(JSON.stringify({ run, propertyId: prop.id, hostToken: host.token, tokens: guests }) + '\n');
