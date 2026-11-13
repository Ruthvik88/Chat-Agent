import express from 'express';
import { join } from 'node:path';

import { runAgent, type AgentEvent } from './agent';
import { config, currentTime, missingKeys } from './config';
import { onBreakerEvent } from './llm/breaker';
import { GeminiProvider } from './llm/gemini';
import { store } from './memory/store';
import { createSearchProvider } from './search';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(join(process.cwd(), 'src', 'public')));

const search = createSearchProvider();

// Log when a saturated model is taken out of rotation, and when it returns.
onBreakerEvent(({ model, state, until }) => {
  console.log(
    state === 'opened'
      ? `[gemini] circuit breaker opened for ${model}, skipping it until ${new Date(until!).toISOString()}`
      : `[gemini] circuit breaker closed for ${model}, trying it again`,
  );
});

// Load the on-disk conversation index before accepting requests.
await store.init();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, missing: missingKeys() });
});

/**
 * The turns of one session, so the chat page can restore a conversation after
 * a refresh. Only real messages are returned: the search and verification
 * records are internal.
 */
app.get('/api/sessions/:id', async (req, res) => {
  const sessionId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sessionId) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }
  await store.refresh();
  const turns = store
    .get(sessionId)
    .filter((t) => t.kind === 'message' && t.text.trim())
    .map((t) => ({ role: t.role, text: t.text, ts: t.ts, sources: t.sources ?? [], citationChecks: t.citationChecks ?? [] }));
  res.json({ sessionId, turns });
});

app.post('/api/chat', async (req, res) => {
  const body = req.body as {
    message?: string;
    sessionId?: string;
    timezone?: string;
    /** Prior turns to seed the session with, keeping their original timestamps. */
    history?: Array<{ role?: string; content?: string; timestamp?: string }>;
  };
  const message = (body.message ?? '').toString().trim();
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  const missing = missingKeys();
  if (missing.length) {
    res.status(500).json({ error: `Missing API keys: ${missing.join(', ')} (see .env.example)` });
    return;
  }

  const sessionId = (body.sessionId ?? req.header('x-session-id') ?? 'default').toString();
  const timezone = (body.timezone ?? req.header('x-timezone') ?? config.userTimezone).toString();
  if (!isValidTimezone(timezone)) {
    res.status(400).json({
      error: `Unknown time zone "${timezone}". Use an IANA name such as ${config.userTimezone}.`,
    });
    return;
  }

  // Seed any prior turns before answering, so they can be recalled and
  // re-verified exactly as if they had happened in this session.
  const seeded = await seedHistory(sessionId, body.history, timezone);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // The client can stop a turn by closing the connection. Stopping the agent
  // loop here saves the rest of the model's quota, which matters on a free
  // tier where a day holds about twenty requests.
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });
  let answerText = '';
  let completed = false;

  if (seeded) {
    send('status', {
      type: 'status',
      message: `Loaded ${seeded} earlier turn${seeded === 1 ? '' : 's'} into this conversation.`,
    });
  }

  const llm = new GeminiProvider({
    apiKey: config.geminiApiKey,
    model: config.model,
    fallbackModel: config.fallbackModel,
  });

  try {
    for await (const event of runAgent(
      { sessionId, message, timezone },
      { llm, search, store },
    )) {
      if (clientGone) break;
      if (event.type === 'text') answerText += event.text;
      if (event.type === 'done') {
        completed = true;
        const m = event.metrics;
        console.log(
          `[chat] ${sessionId} ttft=${m.ttft_ms ?? '-'}ms answer_ttft=${m.answer_ttft_ms ?? '-'}ms ` +
            `model_call_1=${m.model_call_1_ms ?? '-'}ms search=${m.search_ms ?? '-'}ms ` +
            `model_call_2_ttft=${m.model_call_2_ttft_ms ?? '-'}ms thinking_tok=${m.thinking_tokens ?? '-'} ` +
            `total=${m.total_ms}ms model=${m.model_used} primary=${m.primary_model} ` +
            `retries=${m.retries} fallback=${m.fallback_used} searches=${m.search_calls} ` +
            `steps=${m.step_count} model_total=${m.model_ms}ms overhead=${m.overhead_ms}ms unaccounted=${m.unaccounted_ms}ms ` +
            `rounds=${JSON.stringify(m.search_rounds)} calls=${JSON.stringify(m.steps)}`,
        );
        send('done', { sessionId, ...m });
        continue;
      }
      send(mapEvent(event), event);
    }
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    // A stopped turn never reached the agent's own save, so the partial
    // answer is kept here instead of being lost.
    if (clientGone && !completed && answerText.trim()) {
      await store.append(sessionId, {
        ts: currentTime().toISOString(),
        tz: timezone,
        role: 'assistant',
        kind: 'message',
        text: answerText.trim(),
      });
    }
    res.end();
  }
});

/** True when the string is an IANA time zone the runtime understands. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates and stores the `history` field. Returns how many turns were added. */
async function seedHistory(
  sessionId: string,
  history: Array<{ role?: string; content?: string; timestamp?: string }> | undefined,
  timezone: string,
): Promise<number> {
  if (!Array.isArray(history) || !history.length) return 0;
  const turns = history.flatMap((h): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> => {
    const role = h.role === 'assistant' ? 'assistant' : h.role === 'user' ? 'user' : null;
    const content = typeof h.content === 'string' ? h.content.trim() : '';
    const timestamp = typeof h.timestamp === 'string' ? h.timestamp : '';
    if (!role || !content || !timestamp || Number.isNaN(Date.parse(timestamp))) return [];
    return [{ role, content, timestamp: new Date(timestamp).toISOString() }];
  });
  if (!turns.length) return 0;
  return store.seed(sessionId, turns, timezone);
}

function mapEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'text':
      return 'delta';
    case 'status':
      return 'status';
    case 'tool':
      return 'tool';
    case 'sources':
      return 'sources';
    case 'citations':
      return 'citations';
    case 'error':
      return 'error';
    case 'done':
      return 'done';
  }
}

const port = config.port;
app.listen(port, () => {
  console.log(`minimi listening on http://localhost:${port}`);
  const missing = missingKeys();
  if (missing.length) {
    console.warn(`Warning: missing API keys: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
});
