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

const host = await user('host');
await db.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,'HOST') ON CONFLICT DO NOTHING`, [host.id]);
const { rows: [prop] } = await db.query(
  `INSERT INTO properties(host_id, slug, title, property_type, max_guests, city, region, lat, lng, rental_enabled, instant_book,
                          base_price_minor, currency, status, paid_booking_enabled, published_at)
   VALUES ($1, $2, 'Load test stay', 'APARTMENT', 4, 'Seoul', 'Seoul', 37.5665, 126.9780, true, true, 100000, 'KRW', 'PUBLISHED', true, now())
   RETURNING id`, [host.id, `load-${run}`]);
const guests = [];
for (let i = 0; i < N; i++) guests.push((await user(`g${i}`)).token);
await db.end();
process.stdout.write(JSON.stringify({ run, propertyId: prop.id, hostToken: host.token, tokens: guests }) + '\n');
