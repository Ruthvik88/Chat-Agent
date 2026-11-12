/**
 * Posts to /api/chat with an optional `history` block and prints the SSE.
 *
 * Usage: npx tsx test/probe-history.ts
 */
const history = [
  {
    role: 'user',
    content: 'Compare Neon and Railway for Postgres hosting for a small team. What do they each cost?',
    timestamp: process.env.SEED_TS ?? '2026-11-10T06:00:00.000Z',
  },
  {
    role: 'assistant',
    content:
      'Neon starts at $19 per month on its Launch plan. Railway is usage-based; a small Postgres container ' +
      'usually runs $5-$20 per month depending on RAM, disk and egress.',
    timestamp: process.env.SEED_TS ?? '2026-11-10T06:01:00.000Z',
  },
];

const message = process.argv[2] ?? 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
const sessionId = process.argv[3] ?? 'history-probe';

const t0 = Date.now();
const res = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, sessionId, timezone: 'Asia/Kolkata', history }),
});

console.log(`### PROMPT: ${message}`);
console.log(`### HISTORY: ${history.length} seeded turns`);
console.log(`### HTTP ${res.status} ${res.headers.get('content-type')}`);
console.log('### --- raw SSE ---');

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let ttft: number | null = null;
let text = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    if (!frame.trim()) continue;
    const at = Date.now() - t0;
    if (ttft === null && /^event: delta$/m.test(frame)) ttft = at;
    const ev = /^event: (\w+)$/m.exec(frame)?.[1] ?? '?';
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
    if (ev === 'delta') {
      try { text += JSON.parse(data).text ?? ''; } catch {}
    }
    console.log(`[${String(at).padStart(6)}ms] ${frame.replace(/\n/g, ' | ')}`);
  }
}

console.log('### --- end SSE ---');
console.log(`### ttft=${ttft ?? 'n/a'}ms total=${Date.now() - t0}ms`);
console.log('### --- answer text ---');
console.log(text);
