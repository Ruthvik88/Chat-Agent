import './setup';
import assert from 'node:assert/strict';
import { assessClaim, reverifyAnswer, renderReverifyContext, type ReverifyReport } from '../src/memory/reverify';
import { runAgent, type AgentEvent } from '../src/agent';
import { SessionStore, type Source } from '../src/memory/store';
import { isDated } from '../src/search/official';
import { TavilySearchProvider } from '../src/search/tavily';
import { renderSourcesHtml } from '../src/public/markdown.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import type { SearchRequest } from '../src/search/types';

const now = new Date('2026-11-12T09:00:00+05:30');
const claim = 'Pipedrive Essentials is $24/user/month';
const page = (value: number, official = true): Source => ({ title: 'Pipedrive pricing',
  url: official ? 'https://pipedrive.com/pricing' : 'https://blog.example/pipedrive',
  official, excerpt: `Pipedrive Essentials costs $${value} per user per month.` });
for (const [pages, verdict, value] of [
  [[page(24)], 'Unchanged', '$24'], [[page(24, false)], 'Could not verify', undefined],
  [[page(30)], 'Changed', '$30'],
] as const) {
  assert.deepEqual(assessClaim(claim, 'Pipedrive CRM', [...pages], '2026-11-09', now),
    { verdict, ...(value ? { value, url: pages[0].url } : {}) });
}
assert.equal(assessClaim(claim, 'Pipedrive CRM', [page(24, false), {...page(30), excerpt: 'Pipedrive pricing available on request'}], '2026-11-09', now)?.verdict, 'Could not verify');
assert.equal(assessClaim(claim, 'Pipedrive CRM', [{...page(30), excerpt: 'Pipedrive Growth costs $30 per user per month'}], '2026-11-09', now)?.verdict, 'Could not verify', 'different plan is not a price change');
assert.equal(isDated('2024-04-25', now), true);
assert.equal(isDated('2025-11-12T03:30:00Z', now), false);
assert.match(renderSourcesHtml([{...page(24), publishedDate: '2024-04-25', dated: true}]), /dated \(over 12 months old\)/);

// Real adapter, canned HTTP: official missing/low scores survive; lookalike domains do not.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ results: [
  {title:'Pricing',url:'https://neon.tech/pricing',content:'Neon',score:0.01},
  {title:'Limits',url:'https://neon.tech/docs/limits',content:'Neon'},
  {title:'Fake',url:'https://neon.tech.evil.example/pricing',content:'Neon',score:0.01},
]}));
try {
  const results = await new TavilySearchProvider('test-only').search({query:'Neon serverless Postgres pricing',includeDomains:['neon.tech']});
  assert.equal(results.length, 2); assert.ok(results.every((s) => s.official));
} finally { globalThis.fetch = originalFetch; }

// Canned search + scripted model: verify orchestration, source order, disclaimer and prompt contract.
for (const official of [true, false]) {
  const requests: LlmRequest[] = []; const searches: SearchRequest[] = [];
  const llm: LlmProvider = {name:'canned',model:'canned',primaryModel:'canned',stats:{retries:0,fallbackUsed:false},
    async structured<T>() { return {claims:[{claim,subject:'Pipedrive CRM',queries:['Pipedrive CRM news']}]} as T; },
    async *stream(req) {
      requests.push(structuredClone(req));
      if (req.tools?.length) {yield {type:'tool_calls',calls:[{name:'web_search',args:{query:'Neon serverless Postgres pricing'}}]};return;}
      yield {type:'text',text: official ? 'Neon costs $0 [1].' : 'Neon blog reports $0 (unverified background) [1].'};
    },
  };
  const store = new SessionStore(); await store.init();
  const events: AgentEvent[] = [];
  for await (const event of runAgent({sessionId:`official-${official}`,message:'What does Neon cost for serverless Postgres?',timezone:'Asia/Kolkata',now}, {store,llm,
    search:{name:'canned',async search(req) {searches.push(req);return req.includeDomains && official
      ? [{title:'Neon pricing',url:'https://neon.tech/pricing',content:'Neon costs $0.',score:0.01}]
      : [{title:'Neon blog',url:'https://blog.example/neon',content:'Neon costs $0.',score:0.99,publishedDate:'2024-04-25'}];}},
  })) events.push(event);
  assert.equal(searches.length,2); assert.deepEqual(searches[0].includeDomains,['neon.tech']);
  assert.equal(requests.length,2); assert.equal(requests[1].tools?.length,0);
  assert.match(requests[1].system,/older than 12 months/);
  const sources = events.filter((e)=>e.type==='sources').at(-1)!.sources;
  assert.equal(sources[0].official,official);
  const answer = events.filter((e)=>e.type==='text').map((e)=>e.text).join('');
  if (official) assert.match(answer,/Neon costs \$0 \[1\]/);
  else assert.match(answer,/I couldn't confirm the current figure from an official page/);
  assert.equal(sources.find((s)=>s.url.includes('blog'))?.dated,true);
  assert.equal(events.find((e)=>e.type==='done')!.metrics.search_rounds.length,1);

  // Exercise the real re-verify pipeline, not only its helper.
  await store.append(`reverify-${official}`, {ts:'2026-11-09T03:30:00Z',tz:'Asia/Kolkata',role:'assistant',kind:'message',text:claim});
  for (const price of [24,30]) {
    let report!: ReverifyReport; const calls: SearchRequest[] = [];
    for await (const e of reverifyAnswer({store,llm,sessionId:`reverify-${official}`,question:'Has Pipedrive pricing changed since?',dateRefs:[],tz:'Asia/Kolkata',now,
      search:{async search(req) {calls.push(req);const s=page(price,official);return [{...s,content:s.excerpt!}];}},
    })) if(e.type==='report') report=e.report;
    assert.equal(calls.length,2); assert.equal(calls[0].topic,'news'); assert.equal(calls[0].startDate,'2026-11-09');
    assert.deepEqual(calls[1].includeDomains,['pipedrive.com']); assert.equal(calls[1].startDate,undefined);
    assert.equal(report.checks[0].assessment?.verdict,official ? price===24 ? 'Unchanged':'Changed':'Could not verify');
    assert.match(renderReverifyContext(report),/the official page currently shows X, matching your earlier answer/);
  }
}
console.log('official evidence: adapter exemption, same/different/blog-only verdicts, one parallel round, official-first citations, missing-official notice and dated UI passed (canned)');

// Date-only table evidence inherits its claim's entity, rather than treating Nov as a product.
const { checkCitations } = await import('../src/citations');
const table = '| Pipedrive Essentials $24 [1] | Unchanged | 12 Nov 2026 [1] |';
assert.ok(checkCitations(table, [{...page(24), id:1}]).every((c) => c.verified));
const { renderCitedMarkdown } = await import('../src/public/markdown.js');
assert.match(renderCitedMarkdown('| Claim | Verdict | Evidence |\n|---|---|---|\n| Pipedrive | Unchanged | No source |', [], [
  {offset:'| Claim | Verdict | Evidence |\n|---|---|---|\n'.length,id:0,entity:'Pipedrive',verified:false,reason:'verdict lacks required official/value evidence'},
]), /Could not verify/);
