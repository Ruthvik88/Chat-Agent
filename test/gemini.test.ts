import './setup';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../src/config';
import { GeminiProvider, validateAgainstSchema } from '../src/llm/gemini';
import { SessionStore } from '../src/memory/store';

const SESSION = `test-gemini-${Date.now()}`;

/**
 * Replaces the SDK's HTTP layer with a fake that records the request bodies,
 * so we can assert on what would actually be sent to Gemini.
 */
function fakeApi(responses: Array<{ text: string; functionCall?: { name: string; args: Record<string, unknown> } }>) {
  const sent: any[] = [];
  let call = 0;

  const install = () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push(body);
      const next = responses[Math.min(call++, responses.length - 1)];
      const parts: any[] = [];
      if (next.text) parts.push({ text: next.text });
      if (next.functionCall) {
        parts.push({ functionCall: { name: next.functionCall.name, args: next.functionCall.args, id: 'fc-1' } });
      }
      const payload = {
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 17, thoughtsTokenCount: 2 },
      };
      // Streaming uses SSE framing; non-streaming returns plain JSON.
      if (String(url).includes('streamGenerateContent')) {
        return new Response(`data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify({ usageMetadata: payload.usageMetadata })}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  };

  return { sent, restore: install, install };
}

async function main() {
  const store = new SessionStore();
  await store.init();

  const { sent, restore, install } = fakeApi([
    { text: '', functionCall: { name: 'web_search', args: { query: 'neon pricing' } } },
    { text: 'Neon now charges $25 per month.' },
  ]);
  install();

  const provider = new GeminiProvider({ apiKey: 'test', model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' });

  const turns: any[] = [{ role: 'user', text: 'What is Neon pricing?' }];
  const request = {
    system: 'sys',
    turns,
    tools: [
      {
        name: 'web_search',
        description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
  };

  // --- First turn: the model calls the tool ---
  const events: any[] = [];
  for await (const e of provider.stream(request)) events.push(e);

  const toolEvent = events.find((e) => e.type === 'tool_calls');
  assert.ok(toolEvent, 'expected a tool_calls event');
  assert.equal(toolEvent.calls[0].name, 'web_search');
  assert.deepEqual(toolEvent.calls[0].args, { query: 'neon pricing' });
  assert.equal(toolEvent.calls[0].id, 'fc-1');

  // The request must declare exactly one function.
  const first = sent[0];
  assert.equal(first.generationConfig.thinkingConfig.thinkingLevel, 'LOW', '3.8 minimum supported thinking level');
  assert.equal(provider.stats.thinkingTokens, 2, 'cumulative streamed usage must not be double counted');
  assert.equal(provider.stats.modelAttempts.length, 1);
  assert.equal(provider.stats.modelAttempts[0].failed, false);
  assert.ok(provider.stats.modelAttempts[0].ttft_ms !== null);
  assert.equal(first.tools.length, 1);
  assert.equal(first.tools[0].functionDeclarations.length, 1);
  assert.equal(first.tools[0].functionDeclarations[0].name, 'web_search');
  // No Google Search grounding.
  assert.ok(!JSON.stringify(first).includes('googleSearch'), 'must not use Google Search grounding');
  assert.ok(!JSON.stringify(first).includes('urlContext'));

  // --- Second turn: feed the tool result back ---
  turns.push({ role: 'assistant', text: '', toolCalls: toolEvent.calls, opaque: toolEvent.opaque });
  turns.push({
    role: 'user',
    toolResults: [{ name: 'web_search', id: 'fc-1', output: JSON.stringify({ results: [{ title: 't', url: 'u', content: 'c' }] }) }],
  });

  const events2: any[] = [];
  for await (const e of provider.stream({ ...request, turns, tools: [] })) events2.push(e);
  assert.equal(events2.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Neon now charges $25 per month.');

  // The second request must carry the model's functionCall part and the functionResponse.
  const second = sent[1];
  assert.equal(second.toolConfig.functionCallingConfig.mode, 'NONE', 'final synthesis must not call tools');
  const roles = second.contents.map((c: any) => c.role);
  assert.deepEqual(roles, ['user', 'model', 'user']);
  const fnResponse = second.contents[2].parts[0].functionResponse;
  assert.equal(fnResponse.name, 'web_search');
  assert.equal(fnResponse.id, 'fc-1');
  assert.deepEqual(fnResponse.response.results[0].url, 'u');

  assert.equal(provider.stats.thinkingTokens, 4);
  assert.equal(provider.stats.modelAttempts.length, 2);
  restore();

  // --- Structured call: JSON mode with a schema, and a retry when it fails ---
  const sse = fakeApi([
    { text: 'not json at all' },
    { text: JSON.stringify({ claims: [{ claim: 'Neon costs $19', subject: 'Neon' }] }) },
  ]);
  sse.install();
  const structuredProvider = new GeminiProvider({ apiKey: 'test' });
  const claims = await structuredProvider.structured<{ claims: Array<{ claim: string }> }>({
    system: 'extract',
    turns: [{ role: 'user', text: 'previous answer' }],
    responseSchema: {
      type: 'object',
      properties: { claims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] } } },
      required: ['claims'],
    },
  });
  assert.equal(claims.claims.length, 1);
  // The first reply was invalid, so the provider retried once.
  assert.equal(sse.sent.length, 2);
  // The retry must ask for JSON mode with the schema.
  assert.equal(sse.sent[0].generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(structuredProvider.stats.modelAttempts.length, 2, 'failed JSON attempt is included');
  assert.equal(structuredProvider.stats.modelAttempts[0].failed, true);
  assert.equal(structuredProvider.stats.modelAttempts[0].ttft_ms, null, 'non-streaming TTFT is unavailable, not fabricated');
  assert.equal(structuredProvider.stats.thinkingTokens, 4);
  assert.equal(sse.sent[0].generationConfig.responseMimeType, 'application/json');
  assert.ok(sse.sent[0].generationConfig.responseSchema);
  sse.restore();

  // --- Schema validation ---
  assert.equal(validateAgainstSchema({ claims: [{ claim: 'x', subject: 'y' }] }, {
    type: 'object',
    properties: { claims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] } } },
    required: ['claims'],
  }), null);
  assert.match(
    validateAgainstSchema({}, { type: 'object', properties: { claims: { type: 'array' } }, required: ['claims'] }) ?? '',
    /claims is missing/,
  );
  assert.match(
    validateAgainstSchema({ claims: 'nope' }, { type: 'object', properties: { claims: { type: 'array' } } }) ?? '',
    /should be an array/,
  );

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('gemini provider: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
