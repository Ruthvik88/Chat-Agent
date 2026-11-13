import './setup';
import assert from 'node:assert/strict';

import { rankSources, sourceKey } from '../src/search/results';
import { MIN_RELEVANCE_SCORE, TavilySearchProvider } from '../src/search/tavily';

/** Tavily's published OpenAPI schema for POST /search. */
const TAVILY_OPENAPI = 'https://docs.tavily.com/documentation/api-reference/openapi.json';

async function tavilySearchSchema(): Promise<{
  properties: Record<string, unknown>;
  required: string[];
}> {
  const res = await fetch(TAVILY_OPENAPI);
  assert.equal(res.status, 200, 'could not load Tavily OpenAPI schema');
  const spec = (await res.json()) as any;
  const schema = spec.paths['/search'].post.requestBody.content['application/json'].schema;
  return { properties: schema.properties, required: schema.required ?? ['query'] };
}

/** Intercepts the adapter's fetch and captures the outgoing request body. */
function captureRequest(results: unknown[] = [
  { title: 'T', url: 'https://example.com', content: 'C', published_date: '2026-11-10', score: 0.9 },
]) {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({
        results,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { bodies, restore: () => (globalThis.fetch = original) };
}

async function main() {
  const schema = await tavilySearchSchema();
  const allowed = new Set(Object.keys(schema.properties));
  const provider = new TavilySearchProvider('tvly-test-key');

  // --- every field the adapter may send must exist in Tavily's schema ---
  const cap = captureRequest();

  await provider.search({ query: 'neon pricing' });
  await provider.search({
    query: 'neon pricing change',
    startDate: '2026-11-01',
    endDate: '2026-11-12',
    topic: 'news',
    maxResults: 5,
  });
  await provider.search({ query: 'current pricing', maxAgeHours: 24, includeDomains: ['pipedrive.com'] });
  await provider.search({ query: 'windowed', startDate: '2026-11-01', filterByPublishedDate: true });

  cap.restore();

  assert.equal(cap.bodies.length, 4);

  const allSent = new Set(cap.bodies.flatMap((b) => Object.keys(b)));
  for (const field of allSent) {
    assert.ok(allowed.has(field), `field "${field}" is not in Tavily's published schema`);
  }
  for (const body of cap.bodies) {
    for (const req of schema.required) {
      assert.ok(req in body, `required field "${req}" missing from request`);
    }
  }
  console.log('fields sent, all valid against Tavily OpenAPI:', [...allSent].sort().join(', '));

  // --- field semantics ---
  const [plain, windowed, fresh, filtered] = cap.bodies;

  assert.equal(plain.max_results, 5);
  assert.equal(plain.include_raw_content, false);
  assert.equal(plain.query, 'neon pricing');
  assert.equal(plain.search_depth, 'basic', 'search_depth must be basic: 1 credit instead of 2');
  assert.equal(plain.include_published_date, true);
  assert.equal(plain.include_answer, false, 'Tavily must not synthesise the answer');
  assert.ok(!('max_age_hours' in plain), 'max_age_hours must be opt-in, not automatic');
  assert.ok(!('start_date' in plain) && !('end_date' in plain));

  assert.equal(windowed.start_date, '2026-11-01');
  assert.equal(windowed.end_date, '2026-11-12');
  assert.equal(windowed.topic, 'news');
  assert.equal(windowed.max_results, 5);
  assert.ok(!('max_age_hours' in windowed), 'a date window and max_age_hours are alternatives');

  assert.equal(fresh.max_age_hours, 24);
  assert.deepEqual(fresh.include_domains, ['pipedrive.com']);
  assert.ok(!('start_date' in fresh) && !('end_date' in fresh), 'max_age_hours replaces the date window');

  assert.equal(filtered.filter_by_published_date, true);

  const fixture = captureRequest([
    { url: 'https://vendor.com/pricing?tracking=1', content: 'x'.repeat(900), score: MIN_RELEVANCE_SCORE, raw_content: 'must never reach model' },
    { url: 'http://www.vendor.com/pricing/#plans', content: 'better copy', score: 0.9 },
    { url: 'https://blog.com/low', content: 'unrelated', score: MIN_RELEVANCE_SCORE - 0.001 },
    { url: 'https://blog.com/missing-score', content: 'unknown relevance' },
    ...Array.from({ length: 7 }, (_, i) => ({ url: `https://vendor.com/page${i}`, content: 'y'.repeat(700), score: 0.8 })),
  ]);
  let results;
  try {
    results = await provider.search({ query: 'vendor database pricing', maxResults: 99, includeDomains: ['vendor.com'] });
  } finally { fixture.restore(); }
  assert.equal(fixture.bodies[0].max_results, 5, 'clamp requested count');
  assert.equal(results.length, 5, 'cap response even if server returns extra results');
  assert.equal(results[0].content, 'better copy', 'dedupe picks higher relevance copy');
  assert.ok(results.every((r) => r.content.length <= 500 && r.official && !('raw_content' in r)));
  assert.ok(!results.some((r) => r.url.includes('blog.com')), 'drop low and missing scores');
  const boundary = captureRequest([
    { url: 'https://vendor.com/at', content: 'z'.repeat(600), score: MIN_RELEVANCE_SCORE },
    { url: 'https://vendor.com/below', content: 'bad', score: MIN_RELEVANCE_SCORE - 0.001 },
  ]);
  try {
    const kept = await provider.search({ query: 'vendor database pricing' });
    assert.equal(kept.length, 1, 'threshold is inclusive');
    assert.equal(kept[0].content.length, 500, 'excerpt is trimmed');
  } finally { boundary.restore(); }
  assert.equal(sourceKey('http://WWW.vendor.com/pricing/?utm=foo#plans'), sourceKey('https://vendor.com/pricing'));
  const ranked = rankSources([
    { url: 'https://blog.com/a', score: 0.99 },
    { url: 'https://vendor.com/pricing?x=1', score: 0.65, official: true },
    { url: 'http://www.vendor.com/pricing/', score: 0.9, official: true },
    { url: 'https://blog.com/b', score: 0.8 },
  ]);
  assert.deepEqual(ranked.map((r) => r.url), ['http://www.vendor.com/pricing/', 'https://blog.com/a', 'https://blog.com/b']);
  console.log('tavily trimming, threshold, URL/domain-path dedupe and official ranking: all assertions passed');
  console.log('tavily adapter: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
