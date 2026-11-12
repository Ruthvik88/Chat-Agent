import 'dotenv/config';

/**
 * The first-token budget for the primary model, in milliseconds. A saturated
 * model often holds the connection open without answering, so the primary gets
 * a short deadline; the fallback does not, because there is nothing to fail
 * over to. Zero or less disables the check.
 */
function firstTokenTimeout(raw: string | undefined): number | undefined {
  const ms = Number(raw ?? 5000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  // The primary and fallback are deliberately different models: the free tier
  // counts the ~20 requests/day quota per model, so exhausting one still leaves
  // the other usable. gemini-3.8-flash is the primary; it is also the model
  // most likely to saturate, hence the first-token timeout below.
  model: process.env.MODEL ?? 'gemini-3.8-flash',
  fallbackModel: process.env.FALLBACK_MODEL ?? 'gemini-3.5-flash-lite',
  /** How long the primary model has to produce its first token. */
  primaryTtftTimeoutMs: firstTokenTimeout(process.env.PRIMARY_TTFT_TIMEOUT_MS),
  /** The cheap model used for structured calls (claim extraction). */
  structuredModel: process.env.STRUCTURED_MODEL ?? 'gemini-3.5-flash-lite',
  tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
  /** Overridable so the search backend can be pointed at a stub in tests. */
  tavilyBaseUrl: process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com',
  userTimezone: process.env.USER_TIMEZONE ?? 'Asia/Kolkata',
  dataDir: process.env.DATA_DIR ?? 'data',
  /** ISO datetime that replaces the clock everywhere, for demos and evals. */
  nowOverride: process.env.NOW_OVERRIDE ?? '',
} as const;

/**
 * The current time. `NOW_OVERRIDE` pins it, so a demo or an eval can replay the
 * same day without touching the system clock.
 */
export function currentTime(): Date {
  return config.nowOverride ? new Date(config.nowOverride) : new Date();
}

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push('GEMINI_API_KEY');
  if (!config.tavilyApiKey) missing.push('TAVILY_API_KEY');
  return missing;
}
