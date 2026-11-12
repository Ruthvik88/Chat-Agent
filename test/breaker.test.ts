import assert from 'node:assert/strict';

import { BREAKER_COOLDOWN_MS, isTripped, resetBreaker, tripBreaker } from '../src/llm/breaker';
import { GeminiProvider } from '../src/llm/gemini';

/** A model that answers 503 for the primary and 200 for the fallback. */
function fakeGemini(responses: Array<{ status: number; body: string; text?: string }>) {
  const original = globalThis.fetch;
  const sent: any[] = [];
  let call = 0;
  // The signals of every stalled request, so a test can end one cleanly.
  const stalled: AbortSignal[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    // The model may travel in the URL or in the body; record both.
    const fromUrl = /\/models\/([^:/?]+)/.exec(String(url))?.[1];
    sent.push({ ...body, model: body.model ?? fromUrl });
    const next = responses[Math.min(call++, responses.length - 1)];
    if (next.status === 0) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    // status -1 means the model holds the connection open without answering:
    // the response headers arrive, but the body never yields a chunk. That is
    // what a saturated model looks like from the client's side.
    if (next.status === -1) {
      if (init?.signal) stalled.push(init.signal);
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            controller.error(err);
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const text = next.text ?? 'OK';
    if (next.status === 200) {
      // The streaming endpoint answers with SSE, the plain one with JSON.
      if (String(url).includes('streamGenerateContent')) {
        const sse = `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        })}\n\n`;
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const json = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] });
      return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, stalled, restore: () => (globalThis.fetch = original) };
}

const SATURATED_503 = JSON.stringify({
  error: {
    code: 503,
    message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    status: 'UNAVAILABLE',
  },
});

const DAILY_QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota. Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20. ' +
      'Generate content requests per day limit exceeded on Free Tier. Please retry in 12h2m16s.',
    status: 'RESOURCE_EXHAUSTED',
  },
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
  // --- the breaker opens on a capacity error ---
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: 503, body: SATURATED_503 },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(provider.model, 'fallback-model', 'the request must fail over');
    assert.ok(isTripped('primary-model'), 'the saturated model must be tripped');
    assert.ok(!isTripped('fallback-model'), 'the healthy model must not be tripped');
    const status = events.find((e) => e.type === 'status');
    assert.ok(status, 'the user must be told about the switch');
  }

  // --- the breaker skips the tripped model on the NEXT request ---
  {
    const fake = fakeGemini([{ status: 200, body: '' }]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    await collect(provider);
    fake.restore();

    assert.equal(provider.model, 'fallback-model', 'the tripped model must be skipped');
    assert.equal(fake.sent.length, 1, 'the tripped model must not be called at all');
    assert.equal(fake.sent[0].model, 'fallback-model', 'the request must go straight to the fallback');
  }

  // --- a daily quota error also trips the breaker ---
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: 429, body: DAILY_QUOTA_429 },
      { status: 200, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    const events = await collect(provider);
    fake.restore();

    assert.ok(isTripped('primary-model'), 'a spent model must be tripped');
    const status = events.find((e) => e.type === 'status');
    assert.match(status.message, /quota/i, 'the message must mention the quota');
  }

  // --- the breaker closes after the cool-off period ---
  resetBreaker();
  {
    tripBreaker('primary-model');
    assert.ok(isTripped('primary-model'));
    // Pretend the cool-off has passed.
    assert.ok(!isTripped('primary-model', Date.now() + BREAKER_COOLDOWN_MS + 1), 'the breaker must close');
    assert.ok(!isTripped('primary-model'), 'and stay closed');
  }

  // --- the structured model is used for structured calls ---
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: 200, body: '', text: '{"ok":true}' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'answer-model',
      fallbackModel: 'fallback-model',
      structuredModel: 'cheap-model',
    });
    await provider.structured({ system: 's', turns: [{ role: 'user', text: 'x' }] });
    fake.restore();

    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].model, 'cheap-model', 'structured calls must use the structured model');
  }

  // --- a structured call that fails over must not switch the conversation model ---
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: 503, body: SATURATED_503 },
      { status: 200, body: '', text: '{"ok":true}' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'answer-model',
      fallbackModel: 'fallback-model',
      structuredModel: 'cheap-model',
    });
    await provider.structured({ system: 's', turns: [{ role: 'user', text: 'x' }] });
    fake.restore();

    assert.equal(fake.sent[1].model, 'fallback-model', 'the structured call must fail over');
    assert.equal(
      provider.model,
      'answer-model',
      'a failing structured call must not switch the conversation model',
    );
  }

  // --- a stalled primary model times out, fails over, and trips the breaker ---
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: -1, body: '' },
      { status: 200, body: '', text: 'Answered by the fallback.' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      ttftTimeoutMs: 150,
    });
    const events = await collect(provider);
    fake.restore();

    assert.equal(fake.sent.length, 2, 'the stalled primary must be retried on the fallback');
    assert.equal(fake.sent[0].model, 'primary-model');
    assert.equal(fake.sent[1].model, 'fallback-model', 'the request must go straight to the fallback');
    assert.equal(provider.model, 'fallback-model');
    assert.ok(isTripped('primary-model'), 'a stalled primary must trip the breaker');
    const text = events.find((e) => e.type === 'text');
    assert.equal(text.text, 'Answered by the fallback.', 'the fallback must produce the answer');
    const status = events.find((e) => e.type === 'status');
    assert.ok(status, 'the user must be told about the switch');
    assert.match(status.message, /did not respond in time/i, `unexpected message: ${status.message}`);
  }

  // --- the fallback is not given a first-token deadline ---
  // There is nowhere left to fail over to, so a stalled fallback must be left
  // to the ordinary request timeout rather than failing over again.
  resetBreaker();
  {
    const fake = fakeGemini([
      { status: -1, body: '' },
      { status: -1, body: '' },
    ]);
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      ttftTimeoutMs: 150,
    });
    // The primary trips and the fallback then stalls too; the call must still
    // be pending well past the deadline.
    const pending = collect(provider);
    const raced = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise((r) => setTimeout(() => r('still running'), 400)),
    ]);
    fake.restore();
    assert.equal(raced, 'still running', 'the fallback must not be cut short by the first-token deadline');
    // End the stalled request so the test can finish.
    for (const signal of fake.stalled) (signal as AbortSignal & { abort?: () => void }).abort?.();
    void pending.catch(() => {});
  }

  resetBreaker();
  console.log('circuit breaker: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
