import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runAgent, REVERIFY_SIGNALS } from '../src/agent';
import { config } from '../src/config';
import type { LlmEvent, LlmProvider, LlmRequest } from '../src/llm/types';
import { MAX_REVERIFY_CLAIMS, renderReverifyContext, reverifyAnswer } from '../src/memory/reverify';
import { SessionStore } from '../src/memory/store';
import type { SearchProvider, SearchRequest, SearchResult } from '../src/search/types';

const TZ = 'Asia/Kolkata';
const SESSION_SUFFIX = String(Date.now());
const SESSION = `test-reverify-flow-${Date.now()}`;

/** Returns eight claims, so the cap is what limits the searches. */
class ManyClaimsLlm implements LlmProvider {
  readonly name = 'many-claims';
  readonly model = 'test';

  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  structuredCalls = 0;

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    yield { type: 'text', text: 'ok' };
  }

  async structured<T>(): Promise<T> {
    this.structuredCalls++;
    return {
      claims: Array.from({ length: 8 }, (_, i) => ({
        claim: `Claim number ${i + 1}`,
        subject: `Subject ${i + 1}`,
        queries: [`query ${i + 1}`],
      })),
    } as unknown as T;
  }
}

class CountingSearch implements SearchProvider {
  readonly name = 'counting';
  requests: SearchRequest[] = [];
  /** Set to make each search take this long, so overlap can be observed. */
  delayMs = 0;

  async search(req: SearchRequest): Promise<SearchResult[]> {
    this.requests.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return [{ title: 'T', url: 'https://example.com', content: 'c', publishedDate: '2026-11-11' }];
  }
}

/** Returns nothing, so every claim ends up without evidence. */
class EmptySearch implements SearchProvider {
  readonly name = 'empty';

  async search(): Promise<SearchResult[]> {
    return [];
  }
}

/** Asks for the given queries in turn, then answers — the normal path. */
class ScriptedSearchLlm implements LlmProvider {
  readonly name = 'scripted-search';
  readonly model = 'scripted-search-model';
  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  private turn = 0;
  private structuredCalls = 0;
  /** The requests the provider was asked to make. */
  requests: LlmRequest[] = [];

  constructor(private readonly queries: string[] = ['neon pricing']) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(req);
    this.turn++;
    if (this.turn <= this.queries.length) {
      yield { type: 'tool_calls', calls: [{ name: 'web_search', args: { query: this.queries[this.turn - 1] } }] };
      return;
    }
    yield { type: 'text', text: 'Neon starts at $19 per month.' };
  }

  async structured<T>(): Promise<T> {
    this.structuredCalls++;
    // The single structured call extracts claims and their queries.
    return {
      claims: [
        {
          claim: 'Neon starts at $19 per month',
          subject: 'Neon',
          queries: ['Neon Neon starts at $19 per month', 'Neon pricing current'],
        },
      ],
    } as unknown as T;
  }
}

async function main() {
  // --- 4. Claims are capped at 6, and each claim costs two searches ---
  const store = new SessionStore();
  await store.init();
  await store.append(SESSION, {
    ts: '2026-11-10T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month and Railway at $5 per month.',
  });

  const llm = new ManyClaimsLlm();
  const search = new CountingSearch();
  const now = new Date('2026-11-11T04:30:00.000Z');

  let report;
  const stages: string[] = [];
  for await (const event of reverifyAnswer({
    sessionId: 'same-day-' + SESSION_SUFFIX,
    llm,
    search,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  })) {
    if (event.type === 'status') stages.push(event.message);
    else report = event.report;
  }

  assert.equal(MAX_REVERIFY_CLAIMS, 6);
  assert.equal(report!.checks.length, 6, 'six claims may be checked');
  assert.equal(search.requests.length, 12, 'six claims times two searches each');

  assert.deepEqual(report!.uncheckedClaims, ['Claim number 7', 'Claim number 8']);
  assert.match(renderReverifyContext(report!), /NOT checked.*\n- Claim number 7\n- Claim number 8/);

  // --- 4b. The searches run in parallel ---
  // Ten 200ms searches in parallel take ~200ms; serial would take ~2s.
  const slowSearch = new CountingSearch();
  slowSearch.delayMs = 200;
  const t0 = Date.now();
  for await (const _ of reverifyAnswer({
    sessionId: 'same-day-' + SESSION_SUFFIX,
    llm: new ManyClaimsLlm(),
    search: slowSearch,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  })) {
    // drain
  }
  const elapsed = Date.now() - t0;
  assert.equal(slowSearch.requests.length, 12);
  assert.ok(elapsed < 1200, `expected parallel re-verify searches, took ${elapsed}ms`);

  // --- 4c. Each stage reports progress (there is no verdict stage any more) ---
  assert.equal(stages.length, 2, `expected two stage messages, got ${JSON.stringify(stages)}`);
  assert.match(stages[0], /earlier answer/i);
  assert.match(stages[1], /Searching/i);

  // --- 5. The trigger fires on the documented phrasings ---
  for (const phrase of [
    'is that still correct',
    'has the pricing changed since then',
    'anything new',
    'is that still true',
    'is it still accurate',
    'has anything changed',
    'has it been updated since',
    'any news on this',
  ]) {
    assert.ok(REVERIFY_SIGNALS.test(phrase), `trigger must fire on: ${phrase}`);
  }
  // And stays quiet on questions that merely mention a topic.
  for (const phrase of ['what is the capital of France', 'write me a poem about rain']) {
    assert.ok(!REVERIFY_SIGNALS.test(phrase), `trigger must not fire on: ${phrase}`);
  }

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('reverify flow: all assertions passed');
}

/**
 * An answer given today cannot have changed, so no searches are run and the
 * user is offered a fresh search instead.
 */
async function testSameDayGuard() {
  const store = new SessionStore();
  await store.init();
  const today = '2026-11-11';
  await store.append('same-day-' + SESSION_SUFFIX, {
    ts: '2026-11-11T02:00:00.000Z', // 07:30 IST on 11 Nov
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });

  const llm = new ManyClaimsLlm();
  const search = new CountingSearch();
  const now = new Date('2026-11-11T04:30:00.000Z');

  let report;
  const stages: string[] = [];
  for await (const event of reverifyAnswer({
    sessionId: 'same-day-' + SESSION_SUFFIX,
    llm,
    search,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  })) {
    if (event.type === 'status') stages.push(event.message);
    else report = event.report;
  }

  assert.equal(report!.sameDay, true, 'the report must be flagged as same-day');
  assert.equal(report!.answerDate, today);
  assert.equal(search.requests.length, 0, 'no searches may run for a same-day answer');
  assert.equal(llm.structuredCalls, 0, 'no claim extraction for a same-day answer');
  assert.match(stages[0], /nothing that could have changed/i);

  // The context tells the model to offer a fresh search.
  const block = renderReverifyContext(report!);
  assert.match(block, /nothing can have changed/i);
  assert.match(block, /fresh search/i);

  await rm(join(config.dataDir, 'sessions', 'same-day-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('same-day guard: all assertions passed');
}

/**
 * A re-verify phrase with no earlier answer must fall through to a normal
 * search, not to a re-verify.
 */
async function testNoEarlierAnswerFallsThroughToSearch() {
  const store = new SessionStore();
  await store.init();

  // The model asks for a search, as it would for any fresh question.
  const llm = new ScriptedSearchLlm();
  const search = new CountingSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: 'no-history-' + SESSION_SUFFIX, message: 'has anything changed since then?', timezone: TZ },
    { llm, search, store },
  )) {
    events.push(e);
  }

  // No re-verify stages: there was nothing to re-verify.
  assert.ok(
    !events.some((e) => e.type === 'status' && /claims|Comparing/i.test((e as any).message)),
    'the re-verify flow must not run without an earlier answer',
  );
  // But the normal search path did run.
  assert.equal(search.requests.length, 1, 'a normal search must still happen');
  assert.equal(search.requests[0].query, 'neon pricing');

  await rm(join(config.dataDir, 'sessions', 'no-history-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('no earlier answer falls through to search: all assertions passed');
}




/** The re-verify searches must be counted in the request metrics. */
async function testReverifySearchesAreCounted() {
  const store = new SessionStore();
  await store.init();
  await store.append('counted-' + SESSION_SUFFIX, {
    ts: '2026-11-10T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month.',
  });

  const llm = new ManyClaimsLlm();
  const search = new CountingSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: 'counted-' + SESSION_SUFFIX, message: 'has any pricing changed since then?', timezone: TZ },
    { llm, search, store },
  )) {
    events.push(e);
  }

  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  // Two searches per claim, six claims (no inferred vendor domains in this stub).
  assert.equal((done as any).metrics.search_calls, 12, 're-verify searches must be counted');
  const metrics = (done as any).metrics;
  assert.equal(metrics.steps[0].phase, 'extract');
  assert.equal(metrics.model_call_1_ms, metrics.steps[0].model_ms, 'legacy first-call metric includes extraction');
  assert.equal(metrics.search_rounds[0].phase, 'reverify');
  assert.equal(metrics.search_rounds[0].search_calls, 12);
  assert.equal(metrics.unaccounted_ms, 0);

  await rm(join(config.dataDir, 'sessions', 'counted-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('reverify searches counted: all assertions passed');
}


/**
 * "Since then" means this conversation. An answer in another session that
 * merely contains the word "changed" must not win.
 */
async function testOwnSessionWinsOverOtherSession() {
  const store = new SessionStore();
  await store.init();

  // Another session: a meta-answer that contains "changed" but is about
  // nothing the user asked for.
  await store.append('other-' + SESSION_SUFFIX, {
    ts: '2026-11-12T04:00:00.000Z', // today
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'It looks like you are asking if anything has changed since a previous conversation.',
  });

  // This session: the answer the user means, from a week ago.
  await store.append('mine-' + SESSION_SUFFIX, {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });

  const llm = new ManyClaimsLlm();
  const search = new CountingSearch();
  const now = new Date('2026-11-12T09:00:00.000Z');

  let report;
  for await (const event of reverifyAnswer({
    llm,
    search,
    store,
    sessionId: 'mine-' + SESSION_SUFFIX,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  })) {
    if (event.type === 'report') report = event.report;
  }

  assert.equal(report!.answerDate, '2026-11-05', "the answer from this session must win");
  assert.notEqual(report!.sameDay, true, 'a week-old answer is not a same-day answer');
  assert.ok(search.requests.length > 0, 'the re-verify must actually search');

  await rm(join(config.dataDir, 'sessions', 'other-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  await rm(join(config.dataDir, 'sessions', 'mine-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('own session wins: all assertions passed');
}


/**
 * The re-verify flow already searched. The agent must not repeat those
 * searches, and the final answer step gets no search budget.
 */
async function testNoDuplicateSearches() {
  const store = new SessionStore();
  await store.init();
  await store.append('dup-' + SESSION_SUFFIX, {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });

  // The model asks for exactly the queries the re-verify flow already ran.
  const llm = new ScriptedSearchLlm([
    'Neon Neon starts at $19 per month',
    'Neon pricing current',
    'Neon Neon starts at $19 per month',
  ]);
  const search = new CountingSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: 'dup-' + SESSION_SUFFIX, message: 'has any pricing changed since then?', timezone: TZ },
    { llm, search, store },
  )) {
    events.push(e);
  }

  // The re-verify flow ran its own two searches per claim.
  const reverifySearches = search.requests.filter((r) => r.query.startsWith('Neon '));
  assert.ok(reverifySearches.length > 0, 'the re-verify flow must have searched');
  // The agent asked for the same three queries. None of them may run again.
  assert.equal(
    search.requests.length,
    reverifySearches.length,
    `the agent repeated searches the re-verify flow already ran: ${JSON.stringify(search.requests)}`,
  );

  // And the final answer step must not even be offered the search tool.
  const lastRequest = llm.requests[llm.requests.length - 1];
  assert.equal(lastRequest.tools?.length, 0, 'the answer step must not be offered the search tool');

  await rm(join(config.dataDir, 'sessions', 'dup-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('no duplicate searches: all assertions passed');
}


/**
 * The answer to the question being asked now must not be picked as the
 * "earlier" answer.
 */
async function testCurrentTurnAnswerIsNotTheEarlierOne() {
  const store = new SessionStore();
  await store.init();
  await store.append('cur-' + SESSION_SUFFIX, {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });
  // An answer given *now*, to the very question being asked.
  await store.append('cur-' + SESSION_SUFFIX, {
    ts: '2026-11-12T09:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'No pricing has changed since my previous answer.',
  });

  const llm = new ManyClaimsLlm();
  const search = new CountingSearch();
  const now = new Date('2026-11-12T09:00:00.000Z');

  let report;
  for await (const event of reverifyAnswer({
    sessionId: 'cur-' + SESSION_SUFFIX,
    llm,
    search,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  })) {
    if (event.type === 'report') report = event.report;
  }

  assert.equal(report!.answerDate, '2026-11-05', 'the answer from 5 Nov must be chosen, not the one from today');
  assert.notEqual(report!.sameDay, true);

  await rm(join(config.dataDir, 'sessions', 'cur-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('current-turn answer excluded: all assertions passed');
}


/**
 * A claim with no evidence at all is the one case where the answer step is
 * offered the search tool back.
 */
async function testToolIsOfferedBackWhenAClaimHasNoEvidence() {
  const store = new SessionStore();
  await store.init();
  await store.append('noev-' + SESSION_SUFFIX, {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });

  // The re-verify searches find nothing, so the claim has no evidence.
  const llm = new ScriptedSearchLlm([]);
  const search = new EmptySearch();

  for await (const _ of runAgent(
    { sessionId: 'noev-' + SESSION_SUFFIX, message: 'has any pricing changed since then?', timezone: TZ },
    { llm, search, store },
  )) {
    // drain
  }

  const lastRequest = llm.requests[llm.requests.length - 1];
  assert.equal(lastRequest.tools?.length, 1, 'the answer step must be offered the search tool');

  await rm(join(config.dataDir, 'sessions', 'noev-' + SESSION_SUFFIX + '.jsonl'), { force: true });
  console.log('tool offered back when a claim has no evidence: all assertions passed');
}


// The suites share one data directory, so they must run in sequence.
main()
  .then(testSameDayGuard)
  .then(testNoEarlierAnswerFallsThroughToSearch)
  .then(testReverifySearchesAreCounted)
  .then(testOwnSessionWinsOverOtherSession)
  .then(testNoDuplicateSearches)
  .then(testCurrentTurnAnswerIsNotTheEarlierOne)
  .then(testToolIsOfferedBackWhenAClaimHasNoEvidence)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
