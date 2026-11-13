import './setup';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { config, currentTime } from '../src/config';
import { resolveDateRefs } from '../src/memory/dates';
import { recall } from '../src/memory/recall';
import { SessionStore } from '../src/memory/store';

const TZ = 'Asia/Kolkata';

async function main() {
  // --- 3. NOW_OVERRIDE replaces the clock ---
  const realNow = new Date();
  const before = currentTime();
  assert.ok(Math.abs(before.getTime() - realNow.getTime()) < 5000, 'without an override the clock is the real one');

  // Exercised in a child process, because the override is read from the
  // environment when the config module loads.
  const pinned = execFileSync(
    'npx',
    [
      'tsx',
      '-e',
      'import {currentTime} from "./src/config";console.log(currentTime().toISOString());',
    ],
    {
      env: { ...process.env, NOW_OVERRIDE: '2026-11-12T09:00:00.000Z' },
      encoding: 'utf8',
    },
  ).trim();
  assert.equal(pinned, '2026-11-12T09:00:00.000Z', 'NOW_OVERRIDE must replace the clock');

  // The date resolver takes the same clock, so a pinned day resolves the same way.
  const pinnedRefs = resolveDateRefs('last Tuesday', TZ, new Date('2026-11-12T09:00:00.000Z'));
  assert.equal(pinnedRefs[0].primary.localDate, '2026-11-10');

  // --- 2. History seeding keeps the original timestamps ---
  const store = new SessionStore();
  await store.init();
  const added = await store.seed(
    'seeded',
    [
      { role: 'user', content: 'Earlier question about Neon pricing', timestamp: '2026-11-03T03:30:00.000Z' },
      { role: 'assistant', content: 'Neon starts at $19 per month.', timestamp: '2026-11-03T03:31:00.000Z' },
    ],
    TZ,
  );
  assert.equal(added, 2, 'both turns must be seeded');

  const turns = store.get('seeded');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].ts, '2026-11-03T03:30:00.000Z', 'the original timestamp must be kept');
  assert.equal(turns[0].tz, TZ);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');

  // Seeding the same history again must not duplicate turns.
  const again = await store.seed(
    'seeded',
    [{ role: 'user', content: 'Earlier question about Neon pricing', timestamp: '2026-11-03T03:30:00.000Z' }],
    TZ,
  );
  assert.equal(again, 0, 're-seeding the same turn must be a no-op');
  assert.equal(store.get('seeded').length, 2);

  // --- 2b. Seeding a session that already exists on disk keeps its turns ---
  await rm(join(config.dataDir, 'sessions', 'seeded.jsonl'), { force: true });
  const reopened = new SessionStore();
  await reopened.init();
  await reopened.append('seeded', {
    ts: '2026-11-09T03:30:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'An existing turn from before.',
  });
  const mixed = await reopened.seed(
    'seeded',
    [{ role: 'user', content: 'A newly seeded turn.', timestamp: '2026-11-03T03:30:00.000Z' }],
    TZ,
  );
  assert.equal(mixed, 1, 'the new turn must be added');
  assert.equal(reopened.get('seeded').length, 2, 'the pre-existing turn must survive');
  assert.match(reopened.get('seeded')[0].text, /An existing turn from before/);

  // The seeded turns are recallable by their original date.
  const refs = resolveDateRefs('what did I ask on 3 November', TZ, new Date('2026-11-12T00:00:00Z'));
  const hits = await recall(store, 'other', 'Neon pricing', TZ, refs, 6);
  assert.ok(hits.length, 'seeded turns must be recallable');
  assert.match(hits.map((h) => h.turn.text).join(' '), /Earlier question about Neon pricing/);

  await rm(join(config.dataDir, 'sessions', 'seeded.jsonl'), { force: true });
  console.log('now override + history seeding: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
