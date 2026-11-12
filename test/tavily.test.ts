import assert from 'node:assert/strict';

import { TavilySearchProvider } from '../src/search/tavily';

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
function captureRequest() {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({
        results: [
          { title: 'T', url: 'https://example.com', content: 'C', published_date: '2026-11-10' },
        ],
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
  await provider.search({ query: 'current pricing', maxAgeHours: 24 });
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
  assert.ok(!('start_date' in fresh) && !('end_date' in fresh), 'max_age_hours replaces the date window');

  assert.equal(filtered.filter_by_published_date, true);

  console.log('tavily adapter: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
