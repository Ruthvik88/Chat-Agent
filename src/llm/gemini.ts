import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';

import { config } from '../config';
import { isTripped, tripBreaker } from './breaker';
import type { LlmEvent, LlmProvider, LlmRequest, Turn } from './types';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200, 3000];
/**
 * A single model request must not outlive the turn budget. Gemini can hold a
 * request open for a long time under load, so requests are capped.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The primary model did not produce a token within the first-token deadline.
 *
 * A saturated model often holds the connection open without answering rather
 * than returning a 503, so the stall is detected by a deadline rather than by
 * an error code. It is treated as a capacity failure: the breaker opens and
 * the request fails over.
 */
class FirstTokenTimeoutError extends Error {
  constructor(readonly model: string) {
    super(`${model} did not produce a token in time`);
    this.name = 'FirstTokenTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  const m = /status[= ](\d{3})/.exec(e?.message ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Pulls a human-readable message out of the SDK's nested error payload. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    const inner = parsed.error?.message;
    if (inner) {
      const nested = inner.match(/"message":\s*"([^"]+)"/);
      return nested?.[1] ?? inner;
    }
  } catch {
    // Not JSON; fall through to the raw message.
  }
  return raw.slice(0, 400);
}

/**
 * True when the failure is a capacity problem rather than a transient fault.
 *
 * Gemini answers 503 "This model is currently experiencing high demand" when a
 * model is saturated. Retrying the same saturated model just burns the turn
 * budget, so these fail over to the fallback model instead.
 *
 * A request that timed out counts too: the SDK retries a 503 internally, so a
 * saturated model surfaces as an abort rather than a 503, and must fail over
 * for the same reason.
 */
function isCapacityError(err: unknown): boolean {
  if (err instanceof FirstTokenTimeoutError) return true;
  if (isAbortError(err)) return true;
  const status = statusOf(err);
  if (status === 503) return true;
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('capacity')
  );
}

/** True for a request aborted by our own timeout. */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'AbortError' || /aborted|abort/i.test(e?.message ?? '');
}

/**
 * True when the failure is a rate limit that will not clear by retrying.
 *
 * The free tier enforces a per-model, per-day request quota ("Generate
 * requests per day limit exceeded"). Retrying that is pointless, but falling
 * back to a *different* model is not: quotas are counted per model, so the
 * fallback model has its own budget.
 */
function isDailyQuotaError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('per day limit') ||
    msg.includes('requests per day') ||
    msg.includes('quota exceeded for metric') ||
    (statusOf(err) === 429 && /retry in \d+h/.test(msg))
  );
}

function isRetryable(err: unknown): boolean {
  if (isCapacityError(err) || isDailyQuotaError(err)) return true;
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('unavailable') || msg.includes('deadline') || msg.includes('timeout');
}

/**
 * Gemini implementation of the LLM provider interface.
 *
 * The conversation is stored in Gemini's own `Content` shape so that thought
 * signatures attached to function-call parts survive the round trip, which
 * Gemini 3 requires for function calling.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private readonly ai: GoogleGenAI;
  /** The model currently in use. Changes when the provider fails over. */
  private activeModel: string;
  /** The model this provider was configured with, before any fallback. */
  readonly primaryModel: string;
  /** The cheap model used for structured calls. */
  private readonly structuredModel: string;
  /** How long the primary model has to produce its first token. */
  private readonly ttftTimeoutMs: number | undefined;
  /** Whether this request has already told the user about a model switch. */
  private announcedFallback = false;
  /** Counters for the request, reported back to the caller. */
  readonly stats = { retries: 0, fallbackUsed: false };

  constructor(
    private readonly opts: {
      apiKey?: string;
      model?: string;
      fallbackModel?: string;
      structuredModel?: string;
      ttftTimeoutMs?: number;
    } = {},
  ) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey ?? config.geminiApiKey });
    this.primaryModel = opts.model ?? config.model;
    this.structuredModel = opts.structuredModel ?? config.structuredModel;
    this.ttftTimeoutMs = opts.ttftTimeoutMs ?? config.primaryTtftTimeoutMs;
    this.activeModel = this.pickModel();
  }

  get model(): string {
    return this.activeModel;
  }

  private get fallbackModel(): string {
    return this.opts.fallbackModel ?? config.fallbackModel;
  }

  /** The primary model, unless the breaker has it tripped. */
  private pickModel(): string {
    if (!isTripped(this.primaryModel)) return this.primaryModel;
    if (!isTripped(this.fallbackModel)) return this.fallbackModel;
    return this.primaryModel;
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    let attempt = 0;
    let model = this.pickModel();
    if (model !== this.primaryModel && !this.announcedFallback) {
      // The breaker took the primary out of rotation on an earlier request.
      // Say it once per request, not once per step.
      this.announcedFallback = true;
      this.activeModel = model;
      this.stats.fallbackUsed = true;
      yield {
        type: 'status',
        message: `The primary model is busy right now, so I switched to ${model}.`,
      };
    }
    for (;;) {
      let emitted = false;
      try {
        for await (const event of this.streamOnce(model, req)) {
          if (event.type !== 'status') emitted = true;
          yield event;
        }
        return;
      } catch (err) {
        // A failure after text has been streamed cannot be retried cleanly.
        if (emitted || !isRetryable(err)) throw new Error(errorMessage(err));

        // A saturated model, or one whose daily quota is spent, will not
        // recover by being retried. Trip the breaker so later requests skip it
        // too, and fail over to the fallback model, which has its own quota.
        const hopeless = isCapacityError(err) || isDailyQuotaError(err);
        if (hopeless) tripBreaker(model);
        if (!hopeless && attempt < MAX_ATTEMPTS) {
          this.stats.retries++;
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
          attempt++;
          continue;
        }
        // Fail over to the fallback. The breaker decides which model to try
        // *first*; it does not forbid the others. When the fallback is the
        // only model left, trying it beats failing the turn.
        if (model !== this.fallbackModel) {
          const from = model;
          model = this.fallbackModel;
          this.activeModel = model;
          this.stats.fallbackUsed = true;
          // Tell the user once per request: a turn runs several steps, and the
          // switch is worth saying once, not once per step.
          if (!this.announcedFallback) {
            this.announcedFallback = true;
            yield {
              type: 'status',
              message: isDailyQuotaError(err)
                ? `${from} has used up its free-tier request quota for today, so I switched to ${model}.`
                : err instanceof FirstTokenTimeoutError
                  ? `${from} did not respond in time, so I switched to ${model}.`
                  : `The primary model is busy right now, so I switched to ${model}.`,
            };
          }
          attempt = 0;
          continue;
        }
        throw new Error(errorMessage(err));
      }
    }
  }

  private async *streamOnce(model: string, req: LlmRequest): AsyncIterable<LlmEvent> {
    const contents = toContents(req.turns);
    // The primary model gets a first-token deadline. A saturated model often
    // holds the connection open without answering, and that is indistinguishable
    // from a slow one until the deadline passes. The fallback gets none: there
    // is nothing left to fail over to.
    const deadlineMs = model === this.primaryModel ? this.ttftTimeoutMs : undefined;
    const controller = new AbortController();
    let ttftExpired = false;
    const timer = deadlineMs
      ? setTimeout(() => {
          ttftExpired = true;
          controller.abort();
        }, deadlineMs)
      : undefined;
    // The deadline is for the *first* token only: once the model has started
    // answering, the ordinary request timeout takes over.
    const clearDeadline = () => {
      if (timer) clearTimeout(timer);
    };
    try {
      const stream = await this.ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: req.system,
          abortSignal: AbortSignal.any([
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            controller.signal,
          ]),
          // The SDK retries 5xx five times by default, which duplicates the
          // retry-and-fail-over policy below and turns a saturated model into a
          // 30 s hang. One attempt per call here.
          httpOptions: { retryOptions: { attempts: 1 } },
          ...(req.tools?.length
            ? {
                tools: [
                  {
                    functionDeclarations: req.tools.map(
                      (t): FunctionDeclaration => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters as FunctionDeclaration['parameters'],
                      }),
                    ),
                  },
                ],
              }
            : {}),
        },
      });

      // Gemini replays the model's own parts so that thought signatures survive.
      // Streamed chunks are kept as separate contents, exactly as the SDK does.
      const modelContents: Content[] = [];
      const calls: Array<{ id?: string; name: string; args: Record<string, unknown> }> = [];
      const seenCalls = new Set<string>();

      for await (const chunk of stream) {
        const content = chunk.candidates?.[0]?.content;
        if (content) modelContents.push(content);
        // Any output at all means the model is answering, so the first-token
        // deadline is satisfied. A thought counts: it is still a live model.
        if (content?.parts?.length) clearDeadline();
        for (const part of content?.parts ?? []) {
          if (part.functionCall) {
            const key = `${part.functionCall.id ?? ''}:${part.functionCall.name}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key);
            calls.push({
              id: part.functionCall.id,
              name: part.functionCall.name ?? 'unknown',
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
            continue;
          }
          if (part.thought === true) continue;
          if (typeof part.text === 'string' && part.text) {
            yield { type: 'text', text: part.text };
          }
        }
      }

      if (calls.length) {
        yield { type: 'tool_calls', calls, opaque: modelContents };
      }
    } catch (err) {
      // The abort above surfaces as a generic error; name it, so the failover
      // message and the breaker can say what actually happened.
      if (ttftExpired) throw new FirstTokenTimeoutError(model);
      throw err;
    } finally {
      clearDeadline();
    }
  }

  /**
   * Structured call with a JSON schema.
   *
   * Runs on the cheap STRUCTURED_MODEL rather than the conversation model: it
   * is a mechanical extraction task and does not need the better (and
   * scarcer) answer model.
   *
   * The response is validated against the schema; if it does not validate, the
   * call is retried once with the failure appended as feedback.
   */
  async structured<T>(req: LlmRequest): Promise<T> {
    let attempt = 0;
    // The structured call has its own model chain. It never touches
    // `activeModel`: a cheap extraction call failing says nothing about
    // whether the conversation model is healthy.
    const chain = this.structuredChain();
    let model = chain[0];
    let feedback = '';
    for (;;) {
      const turns = feedback ? withFeedback(req.turns, feedback) : req.turns;
      try {
        const res = await this.ai.models.generateContent({
          model,
          contents: toContents(turns),
          config: {
            systemInstruction: req.system,
            abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            // One attempt per call; the retry policy lives in this class.
            httpOptions: { retryOptions: { attempts: 1 } },
            responseMimeType: 'application/json',
            responseSchema: req.responseSchema as never,
          },
        });
        const text = res.text ?? '';
        const parsed = JSON.parse(text) as T;
        const problem = validateAgainstSchema(parsed, req.responseSchema);
        if (!problem) return parsed;
        feedback = `Your previous reply did not satisfy the schema: ${problem}. Reply with valid JSON only.`;
      } catch (err) {
        if (!isRetryable(err)) {
          if (attempt === 0) {
            // A malformed JSON body is worth one retry.
            attempt++;
            feedback = `Your previous reply was not valid JSON: ${errorMessage(err)}. Reply with valid JSON only.`;
            continue;
          }
          throw new Error(errorMessage(err));
        }
        const hopeless = isCapacityError(err) || isDailyQuotaError(err);
        if (hopeless) tripBreaker(model);
        if (!hopeless && attempt < MAX_ATTEMPTS) {
          this.stats.retries++;
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
          attempt++;
          continue;
        }
        const next = chain.find((m) => m !== model && !isTripped(m));
        if (next) {
          model = next;
          attempt = 0;
          continue;
        }
        throw new Error(errorMessage(err));
      }

      // The reply parsed but did not match the schema: retry once with feedback.
      if (attempt === 0) {
        attempt++;
        continue;
      }
      throw new Error('The model did not return valid JSON for the requested schema.');
    }
  }

  /**
   * The models a structured call may use, in order: the cheap structured model,
   * then the fallback, then the primary as a last resort. Models the breaker
   * has tripped are skipped.
   */
  private structuredChain(): string[] {
    const chain = [...new Set([this.structuredModel, this.fallbackModel, this.primaryModel])].filter(
      (m) => !isTripped(m),
    );
    // Everything is tripped: try the structured model anyway rather than fail.
    return chain.length ? chain : [this.structuredModel];
  }
}

/**
 * Minimal structural validation of a parsed JSON value against a JSON schema.
 * Returns a human-readable problem, or null when the value is acceptable.
 */
export function validateAgainstSchema(value: unknown, schema?: Record<string, unknown>): string | null {
  if (!schema) return null;
  const type = schema.type;
  const expected = Array.isArray(type) ? type : type ? [String(type)] : [];

  const check = (v: unknown, s: Record<string, unknown>, path: string): string | null => {
    const t = s.type;
    const kinds = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
    if (kinds.includes('object')) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${path} should be an object`;
      const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (s.required ?? []) as string[];
      for (const key of required) {
        if (!(key in (v as Record<string, unknown>))) return `${path}.${key} is missing`;
      }
      for (const [key, sub] of Object.entries(props)) {
        const child = (v as Record<string, unknown>)[key];
        if (child === undefined) continue;
        const problem = check(child, sub, `${path}.${key}`);
        if (problem) return problem;
      }
    } else if (kinds.includes('array')) {
      if (!Array.isArray(v)) return `${path} should be an array`;
      const items = s.items as Record<string, unknown> | undefined;
      if (items) {
        for (let i = 0; i < v.length; i++) {
          const problem = check(v[i], items, `${path}[${i}]`);
          if (problem) return problem;
        }
      }
    } else if (kinds.includes('string')) {
      if (typeof v !== 'string') return `${path} should be a string`;
    } else if (kinds.includes('number')) {
      if (typeof v !== 'number') return `${path} should be a number`;
    } else if (kinds.includes('integer')) {
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${path} should be an integer`;
    } else if (kinds.includes('boolean')) {
      if (typeof v !== 'boolean') return `${path} should be a boolean`;
    }
    return null;
  };

  if (expected.length && !expected.includes('object') && !expected.includes('array')) {
    // Top-level scalar.
    return check(value, schema, 'response');
  }
  return check(value, schema, 'response');
}

/** Converts the provider-agnostic turns into Gemini contents. */
function toContents(turns: Turn[]): Content[] {
  const contents: Content[] = [];
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      // Replay the provider's own content so thought signatures are preserved.
      if (Array.isArray(turn.opaque)) {
        contents.push(...(turn.opaque as Content[]));
      } else if (turn.text) {
        contents.push({ role: 'model', parts: [{ text: turn.text }] });
      }
      continue;
    }

    if (turn.toolResults?.length) {
      contents.push({
        role: 'user',
        parts: turn.toolResults.map((r) => ({
          functionResponse: {
            name: r.name,
            id: r.id,
            response: safeParse(r.output),
          },
        })),
      });
      continue;
    }

    if (turn.text) contents.push({ role: 'user', parts: [{ text: turn.text }] });
  }
  return contents;
}

function safeParse(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return { result: parsed };
  } catch {
    return { result: output };
  }
}

/** Appends retry feedback to the last user turn so roles stay alternating. */
function withFeedback(turns: Turn[], feedback: string): Turn[] {
  const out = [...turns];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user' && !out[i].toolResults?.length) {
      out[i] = { ...out[i], text: `${out[i].text ?? ''}\n\n${feedback}` };
      return out;
    }
  }
  out.push({ role: 'user', text: feedback });
  return out;
}

export type { Content };
