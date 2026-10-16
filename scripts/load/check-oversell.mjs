#!/usr/bin/env node
// G6 — authoritative no-oversell check after the hold race: in PostgreSQL, no two ACTIVE inventory blocks of
// the fixture property may overlap and no more than one ACTIVE/CONVERTED hold may exist per date range.
// Usage: node scripts/load/check-oversell.mjs <fixture.json> [out.json]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api/package.json'));
const pg = require('pg');
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool' });
await db.connect();
const overlaps = (await db.query(
  `SELECT count(*)::int AS n FROM inventory_blocks a JOIN inventory_blocks b
     ON a.property_id = b.property_id AND a.id < b.id AND a.stay_range && b.stay_range
   WHERE a.property_id = $1 AND a.state = 'ACTIVE' AND b.state = 'ACTIVE'`, [fx.propertyId])).rows[0].n;
const multi = (await db.query(
  `SELECT count(*)::int AS n FROM (
     SELECT q.check_in, q.check_out FROM reservation_holds h JOIN booking_quotes q ON q.id = h.quote_id
      WHERE h.property_id = $1 AND h.status IN ('ACTIVE','CONVERTED') GROUP BY 1,2 HAVING count(*) > 1) x`, [fx.propertyId])).rows[0].n;
const holds = (await db.query(`SELECT count(*)::int AS n FROM reservation_holds WHERE property_id = $1`, [fx.propertyId])).rows[0].n;
await db.end();
// A property with no holds has no overlaps either, so holds=0 would report "no oversell" about a race that
// never ran. The absence of a result is not a pass: this check only means something once the race placed a
// hold, so zero holds is a failure of the gate, reported as such rather than silently green.
const result = {
  gate: 'G6',
  check: 'no-oversell',
  ok: holds > 0 && overlaps === 0 && multi === 0,
  detail: `holds=${holds}, overlapping active blocks=${overlaps}, ranges with >1 hold=${multi}`
    + (holds === 0 ? ' — no hold was placed at all, so nothing was verified (check the k6 hold-concurrency output)' : ''),
};
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
