import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { recall } from '../src/memory/recall';
import { resolveDateRefs } from '../src/memory/dates';
import { SessionStore } from '../src/memory/store';
import { config } from '../src/config';

const TZ = 'Asia/Kolkata';
const SESSION = `test-${Date.now()}`;

async function main() {
  const store = new SessionStore();
  await store.init();

  // 3 November 2026, 09:00 IST -> 03:30 UTC
  await store.append(SESSION, {
    ts: '2026-11-03T03:30:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'What are the best Postgres hosting providers for a small team?',
  });
  await store.append(SESSION, {
    ts: '2026-11-03T03:31:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'For a small team, Crunchy Postgres and Supabase both work well.',
  });

  // "Last Tuesday" relative to Wednesday 11 Nov 2026 -> 10 Nov 2026
  await store.append(SESSION, {
    ts: '2026-11-10T06:00:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'Compare Neon and Railway for Postgres hosting.',
  });
  await store.append(SESSION, {
    ts: '2026-11-10T06:01:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month, Railway at $5 per month with usage pricing.',
  });

  const now = new Date('2026-11-11T04:30:00.000Z');

  // --- recall by explicit date ---
  let refs = resolveDateRefs('What did I ask you on 3 November?', TZ, now);
  let hits = await recall(store, SESSION, 'What did I ask you on 3 November?', TZ, refs, 6);
  assert.ok(hits.length, 'expected a hit for 3 November');
  assert.equal(hits[0].localDate, '2026-11-03');
  assert.equal(hits[0].reason, 'date');
  // Both turns of that day are recalled; with no lexical match the most
  // recent one leads.
  assert.match(hits.map((h) => h.turn.text).join(' '), /Postgres hosting providers/);
  assert.match(hits[0].turn.text, /Crunchy Postgres and Supabase/);
  assert.ok(
    hits.some((h) => /Postgres hosting providers/.test(h.turn.text)),
    'the user turn from that day must also be recalled',
  );

  // --- recall by relative date ---
  refs = resolveDateRefs('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', TZ, now);
  hits = await recall(store, SESSION, 'Last Tuesday I asked you about Postgres hosting.', TZ, refs, 6);
  assert.ok(hits.length, 'expected a hit for last Tuesday');
  assert.equal(hits[0].localDate, '2026-11-10');
  assert.match(hits.map((h) => h.turn.text).join(' '), /Neon/);

  // --- recall by topic alone ---
  refs = [];
  hits = await recall(store, SESSION, 'postgres hosting providers', TZ, refs, 6);
  assert.ok(hits.length, 'expected a topic hit');
  assert.match(hits.map((h) => h.turn.text).join(' '), /Postgres/);

  // --- persistence across a restart ---
  const reopened = new SessionStore();
  await reopened.init();
  assert.equal(reopened.get(SESSION).length, 4, 'turns must be reloaded from the JSONL file');

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('memory: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
