/**
 * End-to-end scenario eval for minimi.
 *
 *   npm run eval -- --live          real Gemini, real or stubbed search
 *   npm run eval                    the same, but fails if the API keys are missing
 *
 * The harness starts its own server on a throwaway data directory, so the
 * scenarios see exactly the history they were given and nothing else.
 *
 * It reports what happened; it never bends a scenario to make it pass. A
 * failing check is a finding to fix in the agent, not in this file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import 'dotenv/config';

import { startStub } from './stub-tavily';

// ---------------------------------------------------------------- config

const NOW_OVERRIDE = process.env.NOW_OVERRIDE ?? '2026-11-12T09:00:00+05:30';
const LIVE = process.argv.includes('--live');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const PORT = Number(process.env.EVAL_PORT ?? 3311);
const TZ = 'Asia/Kolkata';
/** Pause between scenarios, so the run stays under the per-minute model quota. */
const SCENARIO_GAP_MS = Number(process.env.EVAL_GAP_MS ?? 8000);

// ---------------------------------------------------------------- types

// The scenarios and their checks live in checks.ts, so they can be exercised
// against a written answer as well as against a live one.
import { SCENARIOS, type Scenario, type TurnResult } from './checks';

// ---------------------------------------------------------------- server

async function waitForHealth(url: string, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ask(
  base: string,
  message: string,
  history: Scenario['history'],
  timeoutMs = 150_000,
): Promise<TurnResult> {
  const result: TurnResult = { text: '', statuses: [], queries: [], sources: [], metrics: {} };
  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId: `eval-${Math.random().toString(36).slice(2)}`,
        timezone: TZ,
        history,
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
        if (name === 'delta') result.text += String(payload.text ?? '');
        else if (name === 'status') result.statuses.push(String(payload.message ?? ''));
        else if (name === 'tool') {
          const args = payload.args as { query?: string } | undefined;
          if (args?.query) result.queries.push(args.query);
        } else if (name === 'sources') {
          result.sources = (payload.sources as TurnResult['sources']) ?? [];
        } else if (name === 'error') {
          result.error = String(payload.message ?? 'unknown error');
        } else if (name === 'done') {
          result.metrics = payload as TurnResult['metrics'];
        }
      }
    }
  } catch (err) {
    result.error = `stream failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

/** Stops a server process, and everything it started. */
async function stopServer(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* already gone */
    }
    setTimeout(resolve, 3000);
  });
}

// ---------------------------------------------------------------- run

interface Row {
  name: string;
  pass: boolean;
  ttft?: number;
  total?: number;
  searches?: number;
  note: string;
  failures: string[];
}

async function main() {
  const children: ChildProcess[] = [];
  let stub: Awaited<ReturnType<typeof startStub>> | undefined;
  let searchesStubbed = false;

  try {
    // The search backend: the real one when a key exists, the local stub
    // otherwise. Either way this is reported at the top of the output.
    const hasKey = !!process.env.TAVILY_API_KEY?.trim();
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(PORT),
      NOW_OVERRIDE,
      USER_TIMEZONE: TZ,
    };

    if (hasKey) {
      delete baseEnv.TAVILY_BASE_URL;
    } else {
      stub = await startStub(0);
      searchesStubbed = true;
      baseEnv.TAVILY_BASE_URL = `http://127.0.0.1:${stub.port}`;
      baseEnv.TAVILY_API_KEY = 'tvly-eval-stub';
    }

    if (!process.env.GEMINI_API_KEY?.trim() && LIVE) {
      console.error('GEMINI_API_KEY is not set. Add it to .env to run a live eval.');
      process.exit(2);
    }

    // The tsx CLI is spawned directly: `npm.cmd` needs a shell on Windows, and
    // the eval has no reason to go through npm to start one process.
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

    console.log('minimi eval');
    console.log(`  clock        NOW_OVERRIDE=${NOW_OVERRIDE} (${TZ})`);
    console.log(`  models       ${LIVE ? 'LIVE (real Gemini API)' : 'live (no --live flag)'}`);
    console.log(
      `  searches     ${
        searchesStubbed
          ? 'STUBBED — local eval stub, no Tavily credits spent'
          : 'LIVE (real Tavily API)'
      }`,
    );
    console.log('  isolation   every scenario runs on its own server and data directory');
    console.log('');

    const rows: Row[] = [];
    let first = true;
    for (const scenario of SCENARIOS) {
      if (ONLY && !scenario.name.includes(ONLY)) continue;
      process.stdout.write(`... ${scenario.name}\n`);

      // The free tier allows about 15 model requests a minute. The scenarios
      // make two or three each, so the run is paced rather than bursted.
      if (!first) await new Promise((r) => setTimeout(r, SCENARIO_GAP_MS));
      first = false;

      // A fresh data directory per scenario. The recall reaches every session
      // on the machine, so one scenario's conversation would otherwise become
      // the next scenario's context — and a scenario that means to run against
      // an empty history would not.
      const dataDir = mkdtempSync(join(tmpdir(), 'minimi-eval-'));
      const server = spawn(process.execPath, [tsx, 'src/server.ts'], {
        env: { ...baseEnv, DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(server);
      let serverLog = '';
      server.stdout?.on('data', (c) => (serverLog += String(c)));
      server.stderr?.on('data', (c) => (serverLog += String(c)));

      const base = `http://127.0.0.1:${PORT}`;
      let result: TurnResult;
      if (!(await waitForHealth(base))) {
        result = { text: '', statuses: [], queries: [], sources: [], metrics: {} };
        result.error = `the server did not start: ${serverLog.slice(0, 200)}`;
      } else {
        result = await ask(base, scenario.message, scenario.history);
      }
      await stopServer(server);
      rmSync(dataDir, { recursive: true, force: true });

      const failures: string[] = [];
      for (const check of scenario.checks) {
        let ok = false;
        try {
          ok = check.test(result);
        } catch {
          ok = false;
        }
        if (!ok) {
          failures.push(`${check.name} — ${check.detail ? check.detail(result) : 'check failed'}`);
        }
      }
      if (result.error) failures.push(`transport error: ${result.error}`);

      const model = result.metrics.model_used ?? '?';
      const note = result.metrics.fallback_used
        ? `${model} (fell back from ${result.metrics.primary_model})`
        : model;

      rows.push({
        name: scenario.name,
        pass: failures.length === 0,
        ttft: result.metrics.ttft_ms,
        total: result.metrics.total_ms,
        searches: result.metrics.search_calls,
        note,
        failures,
      });

      console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${scenario.name}`);
      for (const failure of failures) console.log(`        x ${failure}`);
      if (failures.length) {
        console.log('        --- full answer ---');
        console.log(
          result.text
            .split('\n')
            .map((l) => '        | ' + l)
            .join('\n'),
        );
        console.log('        --- statuses: ' + JSON.stringify(result.statuses));
        console.log('        --- queries:  ' + JSON.stringify(result.queries));
      }
    }

    console.log('');
    console.log('  scenario                                  pass    ttft       total      searches  notes');
    console.log('  ' + '-'.repeat(104));
    for (const row of rows) {
      const ms = (v?: number) => (v === undefined ? '-' : `${v} ms`);
      console.log(
        `  ${row.name.padEnd(40)} ${(row.pass ? 'pass' : 'FAIL').padEnd(7)} ` +
          `${ms(row.ttft).padEnd(10)} ${ms(row.total).padEnd(10)} ` +
          `${String(row.searches ?? '-').padEnd(9)} ${row.note}`,
      );
    }
    const failed = rows.filter((r) => !r.pass);
    const transport = failed.filter((r) => r.failures.some((f) => f.startsWith('transport error')));
    console.log('');
    console.log(`  ${rows.length - failed.length}/${rows.length} scenarios passed`);
    if (transport.length) {
      console.log(
        `  ${transport.length} failed with a transport error (no answer at all — usually the free tier)`,
      );
    }
    if (searchesStubbed) {
      console.log('  NOTE: searches were STUBBED. Search-dependent results prove the flow, not the data.');
    }
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    for (const child of children) {
      await stopServer(child);
    }
    if (stub) await new Promise<void>((r) => stub!.server.close(() => r()));
    // The stub server and the child pipes keep handles open; leave deliberately.
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
