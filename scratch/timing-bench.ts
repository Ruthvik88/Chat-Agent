/**
 * Per-stage timing bench.
 *
 * Runs against ONE long-running server (started externally via `npm start` or
 * `npm run dev`) on PORT (default 3311). Two scenarios, 3 runs each:
 *   A) "latest Node.js version"   — one search, no reverify
 *   B) "has pricing changed"      — reverify flow (extract + 2×search + answer)
 *
 * Usage:
 *   # In one terminal: npm start
 *   # In another:      npx tsx scratch/timing-bench.ts [--port=3311]
 *
 * Prints a markdown table of per-stage timings.
 */

import 'dotenv/config';

const PORT = Number(
  process.argv.find((a) => a.startsWith('--port='))?.slice(7) ??
    process.env.BENCH_PORT ??
    3000,
);
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = 'Asia/Kolkata';

// Seed history for scenario B (re-verify).
const SEED_TS = '2026-11-05T06:00:00.000Z';
const PRICING_HISTORY = [
  {
    role: 'user' as const,
    content: 'Compare Neon and Railway for Postgres hosting for a small team. What do they each cost?',
    timestamp: SEED_TS,
  },
  {
    role: 'assistant' as const,
    content:
      'Neon starts at $19 per month on its Launch plan. Railway is usage-based; a small Postgres ' +
      'container usually runs $5-$20 per month depending on RAM, disk and egress.',
    timestamp: '2026-11-05T06:01:00.000Z',
  },
];

interface Metrics {
  ttft_ms?: number;
  answer_ttft_ms?: number;
  total_ms?: number;
  search_calls?: number;
  extract_ms?: number;
  search_ms?: number;
  model_call_1_ms?: number;
  model_call_2_ttft_ms?: number;
  thinking_tokens?: number;
  model_used?: string;
  primary_model?: string;
  fallback_used?: boolean;
}

interface RunResult {
  metrics: Metrics;
  error?: string;
}

async function ask(
  message: string,
  history?: typeof PRICING_HISTORY,
): Promise<RunResult> {
  const result: RunResult = { metrics: {} };
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId: `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timezone: TZ,
        history,
      }),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (err) {
    result.error = `request failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (!res.ok) {
    result.error = `HTTP ${res.status}`;
    return result;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const name = /^event:\s*(\w+)/m.exec(frame)?.[1];
        const data = /^data:\s*(.*)$/m.exec(frame)?.[1];
        if (!name || !data) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (name === 'done') {
          result.metrics = payload as Metrics;
        } else if (name === 'error') {
          result.error = String(payload.message ?? 'unknown error');
        }
      }
    }
  } catch (err) {
    result.error = `stream failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

function ms(v?: number): string {
  if (v === undefined || v === null) return '—';
  return `${v} ms`;
}

function col(s: string, w: number): string {
  return s.padEnd(w);
}

async function runBench() {
  console.log('');
  console.log(`Timing bench → ${BASE}`);
  console.log('');

  // Check health
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error(`health ${h.status}`);
    const body = (await h.json()) as { ok: boolean; missing?: string[] };
    if (body.missing?.length) {
      console.error(`Server missing API keys: ${body.missing.join(', ')}`);
      process.exit(1);
    }
    console.log('  Server healthy ✓');
  } catch (err) {
    console.error(`Cannot reach server at ${BASE}: ${err instanceof Error ? err.message : err}`);
    console.error('Start the server first with:  npm start');
    process.exit(1);
  }

  const RUNS = 3;
  const GAP_MS = 12_000; // respect free-tier RPM limit

  type Row = {
    label: string;
    run: number;
    model_call_1_ms: number | undefined;
    search_ms: number | undefined;
    answer_ttft_ms: number | undefined;
    ttft_ms: number | undefined;
    total_ms: number | undefined;
    extract_ms: number | undefined;
    thinking_tokens: number | undefined;
    model: string;
    fallback: boolean;
    error?: string;
  };

  const rows: Row[] = [];

  async function runScenario(
    label: string,
    message: string,
    history?: typeof PRICING_HISTORY,
  ) {
    console.log('');
    console.log(`  Scenario: ${label}`);
    for (let i = 1; i <= RUNS; i++) {
      if (i > 1) {
        process.stdout.write(`    [waiting ${GAP_MS / 1000}s between runs] `);
        await new Promise((r) => setTimeout(r, GAP_MS));
        process.stdout.write('\n');
      }
      process.stdout.write(`    Run ${i}/${RUNS} … `);
      const t0 = Date.now();
      const result = await ask(message, history);
      const wall = Date.now() - t0;
      const m = result.metrics;
      process.stdout.write(`done (${wall} ms wall)\n`);
      if (result.error) {
        console.error(`      ERROR: ${result.error}`);
      }
      rows.push({
        label,
        run: i,
        model_call_1_ms: m.model_call_1_ms,
        search_ms: m.search_ms !== undefined && m.search_ms > 0 ? m.search_ms : undefined,
        answer_ttft_ms: m.answer_ttft_ms ?? m.model_call_2_ttft_ms,
        ttft_ms: m.ttft_ms,
        total_ms: m.total_ms,
        extract_ms: m.extract_ms !== undefined && m.extract_ms > 0 ? m.extract_ms : undefined,
        thinking_tokens: m.thinking_tokens,
        model: m.model_used ?? '?',
        fallback: m.fallback_used ?? false,
        error: result.error,
      });
    }
  }

  await runScenario(
    'A: Node.js version (1 search)',
    "What's the latest stable Node.js version?",
    PRICING_HISTORY,
  );

  await runScenario(
    'B: has pricing changed (re-verify)',
    'Has any pricing changed since then?',
    PRICING_HISTORY,
  );

  // ---- Print table ----
  console.log('');
  console.log('## Per-stage timing results');
  console.log('');

  const H = [
    'Scenario', 'Run',
    'call_1_ms', 'search_ms', 'answer_ttft', 'ttft_ms',
    'extract_ms', 'total_ms', 'thinking_tok', 'model', 'fb?',
  ];
  const W = [30, 4, 10, 10, 12, 8, 11, 9, 13, 24, 4];

  const header = H.map((h, i) => col(h, W[i])).join(' | ');
  const sep    = W.map((w) => '-'.repeat(w)).join('-+-');
  console.log(header);
  console.log(sep);

  for (const r of rows) {
    const cols = [
      r.label,
      String(r.run),
      ms(r.model_call_1_ms),
      ms(r.search_ms),
      ms(r.answer_ttft_ms),
      ms(r.ttft_ms),
      ms(r.extract_ms),
      ms(r.total_ms),
      r.thinking_tokens !== undefined ? String(r.thinking_tokens) : '—',
      r.error ? `ERROR: ${r.error.slice(0, 20)}` : r.model + (r.fallback ? ' (fb)' : ''),
      r.fallback ? 'Y' : 'N',
    ];
    console.log(cols.map((c, i) => col(String(c), W[i])).join(' | '));
  }

  console.log('');
  console.log('Notes:');
  console.log('  call_1_ms    = model_call_1_ms from done metadata (time for LLM to decide to search)');
  console.log('  search_ms    = real Tavily wall time (from done metadata)');
  console.log('  answer_ttft  = model_call_2_ttft_ms / answer_ttft_ms (time to first answer token)');
  console.log('  ttft_ms      = wall time from request start to first token ever (includes call_1 for search scenarios)');
  console.log('  extract_ms   = claim extraction LLM call (re-verify only)');
  console.log('');
  console.log('⚠  model_call_1_ms and thinking_tokens are NOT yet in done metadata.');
  console.log('   They require the agent changes described in Step 2 of the task.');
  console.log('   Values shown as — until those fields are added.');
}

runBench().catch((err) => {
  console.error(err);
  process.exit(2);
});

