import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runAgent } from '../src/agent';
import { config } from '../src/config';
import type { LlmEvent, LlmProvider, LlmRequest } from '../src/llm/types';
import { SessionStore } from '../src/memory/store';
import type { SearchProvider, SearchRequest, SearchResult } from '../src/search/types';

const SESSION = `test-agent-${Date.now()}`;

/** A scripted LLM: first turn asks for two searches, second turn answers. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-model';

  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  calls: LlmRequest[] = [];

  constructor(private readonly script: LlmEvent[][]) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.calls.push(structuredClone(req));
    const turn = this.script[this.calls.length - 1] ?? [{ type: 'text', text: 'done' }];
    for (const event of turn) yield event;
  }

  async structured<T>(): Promise<T> {
    return { claims: [], results: [] } as unknown as T;
  }
}

/** A model that only ever asks for more searches, so the step budget runs out. */
class NeverStopsLlm implements LlmProvider {
  readonly name = 'never-stops';
  readonly model = 'never-stops-model';

  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  calls: LlmRequest[] = [];

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.calls.push(structuredClone(req));
    // With no tools offered there is nothing to call, so it answers in text.
    if (!req.tools?.length) {
      yield { type: 'text', text: 'Here is what I found so far.' };
      return;
    }
    yield {
      type: 'tool_calls',
      calls: [{ name: 'web_search', args: { query: `q${this.calls.length}` } }],
    };
  }

  async structured<T>(): Promise<T> {
    return {} as T;
  }
}

class FakeSearch implements SearchProvider {
  readonly name = 'fake';
  seen: SearchRequest[] = [];
  /** Set to make every search take this long, so overlap can be observed. */
  delayMs = 0;

  async search(req: SearchRequest): Promise<SearchResult[]> {
    this.seen.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return [
      {
        title: `Result for ${req.query}`,
        url: `https://example.com/${encodeURIComponent(req.query)}`,
        content: 'snippet',
        publishedDate: '2026-11-10',
      },
    ];
  }
}

async function main() {
  const store = new SessionStore();
  await store.init();

  const llm = new ScriptedLlm([
    [
      {
        type: 'tool_calls',
        calls: [
          { name: 'web_search', args: { query: 'hubspot pricing', start_date: '2026-11-09' } },
          { name: 'web_search', args: { query: 'salesforce pricing', start_date: '2026-11-09' } },
        ],
      },
    ],
    [{ type: 'text', text: 'HubSpot and Salesforce both changed pricing.' }],
  ]);
  const search = new FakeSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: SESSION, message: 'On Monday we shortlisted CRM tools. Has pricing changed?', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    events.push(e);
  }

  // Two searches ran, in parallel, with the resolved date filter.
  assert.equal(search.seen.length, 2, 'expected two searches');
  assert.deepEqual(
    search.seen.map((s) => s.startDate),
    ['2026-11-09', '2026-11-09'],
    'searches must carry the resolved Monday date',
  );

  // The second model turn received the tool results.
  assert.equal(llm.calls.length, 2, 'expected two model turns');
  const second = llm.calls[1];
  const toolTurn = second.turns.find((t) => t.toolResults?.length);
  assert.ok(toolTurn, 'tool results were not sent back to the model');
  assert.equal(toolTurn.toolResults!.length, 2);
  assert.match(toolTurn.toolResults![0].output, /hubspot pricing/);

  // The answer streamed out and was persisted.
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(text, /HubSpot and Salesforce/);
  const stored = store.get(SESSION);
  assert.equal(stored.length, 2, 'user turn and assistant turn should be persisted');
  assert.equal(stored[0].role, 'user');
  assert.equal(stored[1].role, 'assistant');
  assert.match(stored[1].text, /HubSpot/);
  assert.ok(stored[0].ts.endsWith('Z'), 'timestamps must be absolute UTC');
  assert.equal(stored[0].tz, 'Asia/Kolkata');

  // Sources are reported once per unique URL.
  const sourceEvents = events.filter((e) => e.type === 'sources');
  assert.equal(sourceEvents.length, 1);
  assert.equal(sourceEvents[0].sources.length, 2);

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('agent loop: all assertions passed');
}

/** A model that never stops asking for searches must still produce an answer. */
async function testStepExhaustion() {
  const store = new SessionStore();
  await store.init();
  const llm = new NeverStopsLlm();
  const search = new FakeSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: SESSION, message: 'Compare HubSpot and Salesforce pricing', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    events.push(e);
  }

  // The search budget is four per turn, so only four searches run.
  assert.equal(search.seen.length, 4, `expected 4 searches, got ${search.seen.length}`);

  // The final call must drop the tools so the model cannot loop again.
  const last = llm.calls[llm.calls.length - 1];
  assert.equal(last.tools?.length, 0, 'the final call must not offer tools');

  // And there must be an answer, not an empty stream.
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.ok(text.length > 0, 'expected a final answer after the step budget ran out');
  const stored = store.get(SESSION);
  assert.equal(stored[stored.length - 1].role, 'assistant');
  assert.ok(stored[stored.length - 1].text.length > 0, 'the answer must be persisted');

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('step exhaustion: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

testStepExhaustion().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** Tool calls in one turn must be searched in parallel, not one after another. */
async function testParallelSearches() {
  const store = new SessionStore();
  await store.init();
  const llm = new ScriptedLlm([
    [
      {
        type: 'tool_calls',
        calls: [
          { name: 'web_search', args: { query: 'alpha' } },
          { name: 'web_search', args: { query: 'beta' } },
          { name: 'web_search', args: { query: 'gamma' } },
        ],
      },
    ],
    [{ type: 'text', text: 'done' }],
  ]);
  const search = new FakeSearch();
  search.delayMs = 300;

  const t0 = Date.now();
  for await (const _ of runAgent(
    { sessionId: SESSION, message: 'compare three things', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    // drain
  }
  const elapsed = Date.now() - t0;

  assert.equal(search.seen.length, 3);
  // Three 300ms searches run in parallel take ~300ms; serial would be ~900ms.
  assert.ok(elapsed < 700, `expected parallel searches, took ${elapsed}ms`);

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('parallel searches: all assertions passed');
}

testParallelSearches().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** The `done` event carries per-request timings and counters. */
async function testDoneMetrics() {
  const store = new SessionStore();
  await store.init();
  const llm = new ScriptedLlm([
    [
      {
        type: 'tool_calls',
        calls: [{ name: 'web_search', args: { query: 'alpha' } }],
      },
    ],
    [{ type: 'text', text: 'the answer' }],
  ]);
  const search = new FakeSearch();

  const events = [];
  for await (const e of runAgent(
    { sessionId: SESSION, message: 'what is the price', timezone: 'Asia/Kolkata' },
    { llm, search, store },
  )) {
    events.push(e);
  }

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'a done event must be emitted');
  const m = (done as any).metrics;
  assert.equal(typeof m.ttft_ms, 'number', 'ttft_ms must be a number');
  assert.ok(m.ttft_ms > 0);
  assert.equal(m.model_used, 'scripted-model');
  assert.equal(m.retries, 0);
  assert.equal(m.fallback_used, false);
  assert.equal(m.search_calls, 1, 'the one search must be counted');
  assert.ok(m.total_ms >= m.ttft_ms);

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('done metrics: all assertions passed');
}

testDoneMetrics().catch((err) => {
  console.error(err);
  process.exit(1);
});
