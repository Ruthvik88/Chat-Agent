import assert from 'node:assert/strict';

import { resetBreaker } from '../src/llm/breaker';
import { GeminiProvider } from '../src/llm/gemini';

/**
 * Simulates Gemini responses so the failover policy can be asserted without
 * spending quota.
 */
function fakeGemini(responses: Array<{ status: number; body: string }>) {
  const original = globalThis.fetch;
  const sent: any[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push(body);
    const next = responses[Math.min(call++, responses.length - 1)];
    // status 0 means the request was aborted: the SDK's own timeout fires.
    if (next.status === 0) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    const sse = `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
    })}\n\n`;
    if (next.status === 200) {
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = original) };
}

const DAILY_QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota. Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
      'limit: 20, model: gemini-3.5-flash-lite, description: Generate content ' +
      'requests per day limit exceeded on Free Tier. Please retry in 12h2m16s.',
    status: 'RESOURCE_EXHAUSTED',
  },
});

const SATURATED_503 = JSON.stringify({
  error: {
    code: 503,
    message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    status: 'UNAVAILABLE',
  },
});

const MINUTE_429 = JSON.stringify({
  error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' },
});

async function collect(provider: GeminiProvider) {
  const events: any[] = [];
  for await (const e of provider.stream({
    system: 's',
    turns: [{ role: 'user', text: 'hi' }],
  })) {
    events.push(e);
  }
  return events;
}

async function main() {
  // --- A daily-quota 429 must fail over immediately, without retrying ---
  {
    resetBreaker();
    const fake = fakeGemini([
      { status: 429, body: DAILY_QUOTA_429 },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.1-flash-lite',
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(fake.sent.length, 2, 'a daily-quota 429 must not be retried on the same model');
    assert.equal(provider.model, 'gemini-3.1-flash-lite');
    const status = events.find((e) => e.type === 'status');
    assert.ok(status, 'the user must be told about the switch');
    assert.match(status.message, /quota/i);
    assert.match(status.message, /gemini-3\.1-flash-lite/);
    console.log('ok: daily-quota 429 fails over at once, with a quota-specific message');
  }

  // --- A saturated 503 must also fail over at once ---
  {
    resetBreaker();
    const fake = fakeGemini([
      { status: 503, body: SATURATED_503 },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.1-flash-lite',
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(fake.sent.length, 2, 'a saturated 503 must not be retried on the same model');
    assert.equal(provider.model, 'gemini-3.1-flash-lite');
    const status = events.find((e) => e.type === 'status');
    assert.match(status.message, /busy/i);
    console.log('ok: saturated 503 fails over at once');
  }

  // --- A per-minute 429 must be retried with backoff before failing over ---
  {
    resetBreaker();
    const fake = fakeGemini([
      { status: 429, body: MINUTE_429 },
      { status: 429, body: MINUTE_429 },
      { status: 429, body: MINUTE_429 },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.1-flash-lite',
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(fake.sent.length, 4, 'a per-minute 429 should be retried before failing over');
    assert.equal(provider.model, 'gemini-3.5-flash-lite', 'the primary model should recover');
    assert.ok(!events.some((e) => e.type === 'status'), 'no failover should have been announced');
    console.log('ok: per-minute 429 is retried with backoff and recovers on the primary');
  }

  // --- A saturated model whose retries time out surfaces as an abort ---
  {
    resetBreaker();
    const fake = fakeGemini([
      { status: 0, body: 'The operation was aborted' },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.1-flash-lite',
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(fake.sent.length, 2, 'an abort must fail over, not be thrown');
    assert.equal(provider.model, 'gemini-3.1-flash-lite');
    const status = events.find((e) => e.type === 'status');
    assert.ok(status, 'the user must be told about the switch');
    console.log('ok: an aborted request fails over to the fallback model');
  }

  console.log('model failover: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
