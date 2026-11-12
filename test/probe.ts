/**
 * Hits POST /api/chat and prints the raw SSE stream with timings.
 *
 * Usage: npx tsx test/probe.ts "message" [sessionId]
 */
const message = process.argv[2] ?? 'hello';
const sessionId = process.argv[3] ?? 'probe';

const t0 = Date.now();
const res = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, sessionId, timezone: 'Asia/Kolkata' }),
});

console.log(`### PROMPT: ${message}`);
console.log(`### HTTP ${res.status} ${res.headers.get('content-type')}`);
console.log('### --- raw SSE ---');

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let ttft: number | null = null;
let text = '';
let events = 0;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  buffer += chunk;
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    if (!frame.trim()) continue;
    const at = Date.now() - t0;
    events++;
    if (ttft === null && /^event: delta$/m.test(frame)) ttft = at;
    const ev = /^event: (\w+)$/m.exec(frame)?.[1] ?? '?';
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
    let shown = data;
    try {
      const p = JSON.parse(data);
      if (ev === 'delta') {
        text += p.text ?? '';
        shown = JSON.stringify(p);
      } else if (ev === 'sources') {
        shown = JSON.stringify(p.sources?.map((s: any) => s.url));
      }
    } catch {
      /* raw */
    }
    console.log(`[${String(at).padStart(6)}ms] ${frame.replace(/\n/g, ' | ')}`);
  }
}

const total = Date.now() - t0;
console.log('### --- end SSE ---');
console.log(`### events=${events} ttft=${ttft ?? 'n/a'}ms total=${total}ms`);
console.log('### --- answer text ---');
console.log(text);
