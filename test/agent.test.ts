import './setup';
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
    [{ type: 'text', text: 'HubSpot and Salesforce both changed pricing [1].' }],
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
  assert.equal(search.seen.length, 4, 'two general and two official searches');
  assert.deepEqual(
    search.seen.filter((s) => !s.includeDomains).map((s) => s.startDate),
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
  assert.ok(sourceEvents.length >= 1);
  assert.equal(sourceEvents.at(-1)!.sources.length, 2);
  assert.ok(events.findIndex((e) => e.type === 'sources') < events.findIndex((e) => e.type === 'text'));
  assert.deepEqual(sourceEvents.at(-1)!.sources.map((s) => s.id), [1, 2]);

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

  // Three normal steps: at most two search rounds, then synthesis without tools.
  assert.equal(search.seen.length, 1, 'one search round before synthesis');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.type === 'done');
  assert.equal(done.metrics.step_count, 2);

  // The final call must drop the tools so the model cannot loop again.
  const last = llm.calls[llm.calls.length - 1];
  assert.equal(last.tools?.length, 0, 'the final call must not offer tools');
  const synthesis = llm.calls[1];
  assert.equal(synthesis.tools?.length, 0, 'second loop step disables tools');
  assert.match(synthesis.turns.at(-1)!.text!, /Stop searching and answer now/);

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

async function testRankedParallelSourcesAndFollowup() {
  const sessionId = `ranked-${SESSION}`;
  const store = new SessionStore();
  const llm = new ScriptedLlm([
    [{ type: 'tool_calls', calls: [
      { name: 'web_search', args: { query: 'Neon serverless Postgres pricing', include_domains: ['neon.tech'] } },
      { name: 'web_search', args: { query: 'Railway PaaS Postgres pricing' } },
    ] }],
    [{ type: 'text', text: 'Neon offers Postgres [1, 2].' }],
  ]);
  const search: SearchProvider = { name: 'canned', async search(req) {
    if (req.query.startsWith('Neon')) await new Promise((r) => setTimeout(r, 30));
    return [
      { title: 'Pricing', url: req.query.startsWith('Neon') ? 'https://neon.tech/pricing' : 'http://www.neon.tech/pricing/?utm=x', content: 'Postgres pricing', score: 0.7, official: req.query.startsWith('Neon') },
      ...Array.from({ length: 5 }, (_, i) => ({ title: `Blog ${i}`, url: `https://blog.com/${i}?q=${req.query}`, content: 'Postgres pricing', score: 0.99 - i / 100 })),
    ];
  } };
  try {
    const events = [];
    for await (const e of runAgent({ sessionId, message: 'Compare Neon and Railway Postgres prices', timezone: 'Asia/Kolkata' }, { store, llm, search })) events.push(e);
    const results = llm.calls[1].turns.flatMap((t) => t.toolResults ?? []).flatMap((t) => JSON.parse(t.output).results);
    assert.equal(results.length, 6, 'parallel results deduped before model sees them');
    const shortlist = llm.calls[1].turns.flatMap((t) => t.toolResults ?? []).map((t) => JSON.parse(t.output).citationSources).find(Boolean);
    assert.equal(shortlist.length, 6, 'ranked citation shortlist reaches the provider as tool data');
    assert.equal(shortlist[0].domain, 'neon.tech');
    assert.equal(shortlist[0].citation, '[1]');
    assert.ok(!JSON.stringify(shortlist).includes('https://'), 'model sees IDs and domains, never URLs');
    assert.equal(new Set(results.map((r: { id: number }) => r.id)).size, 6);
    const sourceEvent = events.filter((e) => e.type === 'sources').at(-1);
    assert.ok(sourceEvent?.type === 'sources');
    assert.equal(sourceEvent.sources.length, 6);
    assert.equal(sourceEvent.sources[0].url, 'https://neon.tech/pricing', 'official wins despite lower score and slower search');
    assert.equal(store.get(sessionId).at(-1)!.sources!.length, 6);
    const followup = new ScriptedLlm([[{ type: 'tool_calls', calls: [{ name: 'web_search', args: { query: 'Neon serverless Postgres pricing' } }] }], [{ type: 'text', text: 'Neon pricing [1].' }]]);
    const followEvents = [];
    for await (const e of runAgent({ sessionId, message: 'and the other one?', timezone: 'Asia/Kolkata' }, { store, llm: followup, search })) followEvents.push(e);
    const req = followup.calls[0];
    assert.match(req.system, /Every factual claim needs a numbered citation/);
    assert.match(req.system, /Railway PaaS Postgres pricing/);
    assert.ok(followup.calls[1].turns.some((t) => t.toolResults?.some((r) => r.output.includes('neon.tech'))), 'follow-up receives fresh official evidence');
    assert.ok(req.turns.filter((t) => t.role === 'assistant').every((t) => !/\[1, 2\]/.test(t.text ?? '')), 'old grouped IDs must not be rebound to the new turn');
    assert.ok(followEvents.some((e) => e.type === 'sources' && e.sources.some((s) => s.url === 'https://neon.tech/pricing')));
    console.log('parallel source ranking/cap/dedupe and follow-up citation context: all assertions passed');
  } finally { await rm(join(config.dataDir, 'sessions', `${sessionId}.jsonl`), { force: true }); }
}

testRankedParallelSourcesAndFollowup().catch((err) => { console.error(err); process.exit(1); });

async function testStreamingIdsAndSoftFailures() {
  const sessionId = `stream-${SESSION}`;
  const store = new SessionStore();
  let calls = 0;
  let observedFirstToken = false;
  const llm: LlmProvider = {
    name: 'streaming', model: 'mock', primaryModel: 'mock', stats: { retries: 0, fallbackUsed: false },
    async structured<T>() { return {} as T; },
    async *stream() {
      if (++calls === 1) { yield { type: 'tool_calls', calls: [{ name: 'web_search', args: { query: 'Railway PaaS Postgres pricing' } }] }; return; }
      yield { type: 'text', text: 'Railway costs ' };
      assert.ok(observedFirstToken, 'first token must be delivered before generation resumes');
      yield { type: 'text', text: '$5 [1].\nPipedrive costs $24 [1].\nRailway has another plan [999].' };
    },
  };
  try {
    const events = [];
    for await (const e of runAgent({ sessionId, message: 'Railway price?', timezone: 'Asia/Kolkata' }, { store, llm, search: new FakeSearch() })) {
      if (e.type === 'text') observedFirstToken = true;
      events.push(e);
    }
    assert.equal(calls, 2, 'no citation repair model call');
    assert.ok(events.findIndex((e) => e.type === 'sources') < events.findIndex((e) => e.type === 'text'));
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.match(text, /Railway costs \$5 \[1\]/);
    assert.doesNotMatch(text, /could not produce an answer/);
    const validation = events.filter((e) => e.type === 'citations').at(-1);
    assert.ok(validation?.type === 'citations');
    assert.deepEqual(validation.checks.map((c) => c.verified), [true, false, false]);
    assert.equal(validation.checks[2].reason, 'unknown source');
    assert.equal(store.get(sessionId).at(-1)!.citationChecks!.length, 3, 'validation survives reload');
    assert.ok(!events.some((e) => e.type === 'error'));
    console.log('streamed IDs: sources first, immediate tokens, per-claim soft failure, no repair call');
  } finally { await rm(join(config.dataDir, 'sessions', `${sessionId}.jsonl`), { force: true }); }
}

testStreamingIdsAndSoftFailures().catch((err) => { console.error(err); process.exit(1); });

async function testEveryStageIsTimed() {
  const sessionId = `timings-${SESSION}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  class SlowStore extends SessionStore {
    override async append(...args: Parameters<SessionStore['append']>) { await sleep(12); return super.append(...args); }
  }
  const store = new SlowStore();
  const scripted = new ScriptedLlm([
    [{ type: 'tool_calls', calls: [
      { name: 'web_search', args: { query: 'one' } },
      { name: 'web_search', args: { query: 'two' } },
    ] }],
    [{ type: 'text', text: 'Railway answer [1].' }],
  ]);
  const llm: LlmProvider = {
    ...scripted,
    name: scripted.name, model: scripted.model, primaryModel: scripted.primaryModel, stats: scripted.stats,
    structured: scripted.structured.bind(scripted),
    async *stream(req) { await sleep(20); yield* scripted.stream(req); await sleep(15); },
  };
  const search = new FakeSearch(); search.delayMs = 40;
  try {
    const events = [];
    const start = Date.now(); let visibleAt = 0;
    for await (const e of runAgent({ sessionId, message: 'Look up these two database products', timezone: 'Asia/Kolkata' }, { store, llm, search })) {
      if (e.type === 'text' && !visibleAt) visibleAt = Date.now() - start;
      events.push(e);
    }
    const done = events.find((e) => e.type === 'done'); assert.ok(done?.type === 'done');
    const m = done.metrics;
    assert.deepEqual(m.steps.map((s) => s.phase), ['loop', 'loop']);
    assert.equal(m.step_count, 2); assert.equal(m.model_call_count, 2);
    assert.ok(m.steps.every((s) => s.model_ms >= 30 && s.model_ttft_ms! >= 15 && !s.failed));
    assert.equal(m.search_rounds.length, 1); assert.equal(m.search_rounds[0].search_calls, 2);
    assert.ok(m.search_ms >= 35 && m.search_ms < 100, `parallel search round wall time ${m.search_ms}`);
    assert.equal(m.steps[0].search_ms, m.search_ms);
    assert.ok(m.overhead_ms >= 20, 'persistence delays are measured as local overhead');
    assert.equal(m.model_ms, m.steps.reduce((n, s) => n + s.model_ms, 0));
    assert.equal(m.total_ms, m.model_ms + m.search_ms + m.overhead_ms + m.unaccounted_ms);
    assert.equal(m.unaccounted_ms, 0);
    assert.ok(Math.abs(visibleAt - m.ttft_ms!) < 20, 'TTFT measures emitted answer, without buffering');
    assert.ok(m.ttft_ms! >= m.steps[1].start_ms + m.steps[1].model_ttft_ms!);
    assert.ok(m.ttft_ms! < m.steps[1].start_ms + m.steps[1].model_ms, 'text arrives before model call completion');

    const failing: LlmProvider = { ...llm, async *stream() { await sleep(20); throw new Error('simulated provider failure'); } };
    const failed = [];
    for await (const e of runAgent({ sessionId, message: 'Look up a database product', timezone: 'Asia/Kolkata' }, { store, llm: failing, search })) failed.push(e);
    const failedDone = failed.find((e) => e.type === 'done'); assert.ok(failedDone?.type === 'done');
    assert.equal(failedDone.metrics.steps.length, 1);
    assert.equal(failedDone.metrics.steps[0].failed, true);
    assert.equal(failedDone.metrics.ttft_ms, null);
    assert.equal(failedDone.metrics.unaccounted_ms, 0);
    assert.match(failedDone.metrics.error!, /simulated provider failure/);
    assert.ok(failed.some((e) => e.type === 'error'));
    const emptyEvents = [];
    for await (const e of runAgent({ sessionId, message: 'Hello', timezone: 'Asia/Kolkata' }, { store, llm: new ScriptedLlm([[]]), search })) emptyEvents.push(e);
    assert.ok(emptyEvents.some((e) => e.type === 'error' && /no answer.*retry/i.test(e.message)), 'empty model response is a visible retryable error');
    console.log('all-stage timing: extraction, model calls, parallel searches, streaming, failures and visible TTFT accounted');
  } finally { await rm(join(config.dataDir, 'sessions', `${sessionId}.jsonl`), { force: true }); }
}

testEveryStageIsTimed().catch((err) => { console.error(err); process.exit(1); });

async function testInterruptedAnswerIsRemembered() {
  const sessionId = `interrupted-${SESSION}`;
  const store = new SessionStore(); let calls = 0;
  const llm: LlmProvider = {
    name:'broken-stream',model:'mock',primaryModel:'mock',stats:{retries:0,fallbackUsed:false},
    async structured<T>() {return {} as T;},
    async *stream() {
      if (++calls === 1) {yield {type:'tool_calls',calls:[{name:'web_search',args:{query:'Railway PaaS Postgres pricing'}}]}; return;}
      yield {type:'text',text:'Railway costs $5 [1].'};
      throw new Error('503 high demand');
    },
  };
  try {
    const events=[];
    for await (const e of runAgent({sessionId,message:'Railway price?',timezone:'Asia/Kolkata'},{store,llm,search:new FakeSearch()})) events.push(e);
    assert.ok(events.some((e)=>e.type==='text'));
    assert.ok(events.some((e)=>e.type==='error' && /retry/i.test(e.message)));
    const saved=store.get(sessionId).at(-1)!;
    assert.match(saved.text,/Railway costs.*Answer interrupted/s);
    assert.equal(saved.sources![0].id,1); assert.equal(saved.citationChecks![0].verified,true);
    console.log('interrupted stream: text stays visible and partial answer/source mapping survive for follow-ups');
  } finally {await rm(join(config.dataDir,'sessions',`${sessionId}.jsonl`),{force:true});}
}
testInterruptedAnswerIsRemembered().catch((err)=>{console.error(err);process.exit(1);});
