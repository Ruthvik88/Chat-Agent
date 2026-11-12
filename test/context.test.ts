import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runAgent } from '../src/agent';
import { config } from '../src/config';
import type { LlmEvent, LlmProvider, LlmRequest } from '../src/llm/types';
import { SessionStore } from '../src/memory/store';
import type { SearchProvider, SearchRequest, SearchResult } from '../src/search/types';

const SESSION = `test-ctx-${Date.now()}`;

/** Captures the request the agent builds, and answers with plain text. */
class CapturingLlm implements LlmProvider {
  readonly name = 'capturing';
  readonly model = 'test-model';

  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  requests: LlmRequest[] = [];

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(structuredClone(req));
    yield { type: 'text', text: 'ok' };
  }

  async structured<T>(): Promise<T> {
    return {} as T;
  }
}

class NoSearch implements SearchProvider {
  readonly name = 'none';
  requests: SearchRequest[] = [];

  async search(req: SearchRequest): Promise<SearchResult[]> {
    this.requests.push(req);
    return [];
  }
}

async function main() {
  const store = new SessionStore();
  await store.init();

  // An earlier answer on 3 November, in a *different* session.
  await store.append('other-session', {
    ts: '2026-11-03T03:31:00.000Z',
    tz: 'Asia/Kolkata',
    role: 'assistant',
    kind: 'message',
    text: 'Crunchy Postgres and Supabase both work well for a small team.',
  });

  const llm = new CapturingLlm();
  const search = new NoSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: SESSION, message: 'What did I ask you on 3 November?', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    events.push(e);
  }

  assert.equal(llm.requests.length, 1);
  const sent = llm.requests[0];

  // The user turn must carry the recalled turn with its absolute timestamp.
  const userTurn = sent.turns[sent.turns.length - 1];
  assert.match(userTurn.text!, /Crunchy Postgres/);
  assert.match(userTurn.text!, /2026-11-03T03:31:00\.000Z/);
  assert.match(userTurn.text!, /<past_turns>/);

  // The resolved date must be in the system prompt.
  assert.match(sent.system, /"3 november" ->/);
  assert.match(sent.system, /2026-11-03/);

  // No search was needed: the answer came from memory.
  assert.equal(search.requests.length, 0);

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  await rm(join(config.dataDir, 'sessions', 'other-session.jsonl'), { force: true });
  console.log('context injection: all assertions passed');
}

/**
 * A turn on the day the user asks about must reach the model even when it is
 * also replayed as conversation history, and it must carry its date.
 */
async function testDatedTurnIsVisible() {
  const store = new SessionStore();
  await store.init();
  await store.append('dated', {
    ts: '2026-11-03T06:00:00.000Z',
    tz: 'Asia/Kolkata',
    role: 'user',
    kind: 'message',
    text: 'What are the best Postgres hosting providers for a small team?',
  });

  const llm = new CapturingLlm();
  const search = new NoSearch();

  for await (const _ of runAgent(
    { sessionId: 'dated', message: 'What did I ask you on 3 November?', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    // drain
  }

  const sent = llm.requests[0];
  const userTurn = sent.turns[sent.turns.length - 1];

  // The turn reaches the model twice: as dated conversation history and in
  // the <past_turns> block, which is where the date is explicit.
  assert.match(userTurn.text!, /<past_turns>/);
  assert.match(userTurn.text!, /2026-11-03T06:00:00\.000Z/);
  assert.match(userTurn.text!, /Postgres hosting providers/);

  // And the replayed history carries the local day, so the model can tie a
  // turn to a day the user names.
  const historyTurn = sent.turns[0];
  assert.match(historyTurn.text!, /^\[2026-11-03\]/);

  await rm(join(config.dataDir, 'sessions', 'dated.jsonl'), { force: true });
  console.log('dated turn visibility: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

testDatedTurnIsVisible().catch((err) => {
  console.error(err);
  process.exit(1);
});
