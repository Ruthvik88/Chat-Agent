import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config, currentTime } from '../src/config';
import { resolveDateRefs } from '../src/memory/dates';
import { recall } from '../src/memory/recall';
import { SessionStore } from '../src/memory/store';

const TZ = 'Asia/Kolkata';

async function main() {
  const store = new SessionStore();
  await store.init();

  // A turn in one session, a turn in another, both on different days.
  await store.append('session-a', {
    ts: '2026-11-03T03:30:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'What are the best Postgres hosting providers for a small team?',
  });
  await store.append('session-b', {
    ts: '2026-11-10T03:30:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'Compare Neon and Railway for Postgres hosting.',
  });

  // --- 1. Recall searches every session, not just the current one ---
  const refs = resolveDateRefs('What did I ask you on 3 November?', TZ, new Date('2026-11-11T04:30:00Z'));
  const hits = await recall(store, 'session-b', 'What did I ask you on 3 November?', TZ, refs, 6);
  assert.ok(hits.length, 'expected a hit');
  assert.match(
    hits.map((h) => h.turn.text).join(' '),
    /Postgres hosting providers/,
    'the turn in the OTHER session must be found',
  );

  // --- 1b. Date range beats lexical: a same-day turn wins over a topical one ---
  await store.append('session-c', {
    ts: '2026-11-03T09:00:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'Unrelated chatter about lunch on the third.',
  });
  const hits2 = await recall(store, 'session-b', 'Postgres hosting providers', TZ, refs, 6);
  assert.equal(hits2[0].localDate, '2026-11-03', 'the date range must win over lexical overlap');
  assert.equal(hits2[0].reason, 'date');

  // --- 1c. Within the date range, lexical decides ---
  await store.append('session-c', {
    ts: '2026-11-03T10:00:00.000Z',
    tz: TZ,
    role: 'user',
    kind: 'message',
    text: 'Postgres hosting providers for a small team, please.',
  });
  const hits3 = await recall(store, 'session-b', 'Postgres hosting providers', TZ, refs, 6);
  assert.equal(hits3[0].localDate, '2026-11-03');
  assert.match(
    hits3[0].turn.text,
    /Postgres hosting providers for a small team/,
    'within the range, the best lexical match must lead',
  );

  // --- 1d. No lexical match in the range: the most recent turn in the range leads ---
  await store.append('session-d', {
    ts: '2026-11-03T11:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'A late answer that shares no words with the query.',
  });
  const refs2 = resolveDateRefs('what happened on 3 November', TZ, new Date('2026-11-11T04:30:00Z'));
  const hits4 = await recall(store, 'session-b', 'zzzz qqqq', TZ, refs2, 6);
  assert.ok(hits4.length, 'expected the range fallback');
  assert.equal(hits4[0].localDate, '2026-11-03');
  assert.match(hits4[0].turn.text, /A late answer/, 'the most recent turn in the range must lead');

  for (const s of ['session-a', 'session-b', 'session-c', 'session-d']) {
    await rm(join(config.dataDir, 'sessions', `${s}.jsonl`), { force: true });
  }

  // --- 1e. A session file added while the server runs is picked up ---
  await writeFile(
    join(config.dataDir, 'sessions', 'late-session.jsonl'),
    JSON.stringify({
      ts: '2026-11-03T07:00:00.000Z',
      tz: TZ,
      role: 'user',
      kind: 'message',
      text: 'A turn written to disk after the store was initialised.',
    }) + '\n',
  );
  const late = await recall(store, 'session-a', 'turn written to disk', TZ, refs, 6);
  assert.ok(late.length, 'a session file added at runtime must be found');
  assert.match(late[0].turn.text, /written to disk after the store was initialised/);
  await rm(join(config.dataDir, 'sessions', 'late-session.jsonl'), { force: true });

  console.log('recall across sessions: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
