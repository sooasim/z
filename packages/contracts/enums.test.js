import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as E from './enums.js';

// Every enum value must be allowed by the matching CHECK constraint in the migrations.
const sql = readdirSync('../db/migrations').map((f) => readFileSync(`../db/migrations/${f}`, 'utf8')).join('\n');
test('enum values appear in DB check constraints', () => {
  for (const [name, values] of Object.entries(E)) {
    for (const v of values) assert.ok(sql.includes(`'${v}'`), `${name}.${v} not found in migrations`);
  }
});
