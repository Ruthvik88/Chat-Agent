import assert from 'node:assert/strict';

import { resolveDateRefs, zonedParts } from '../src/memory/dates';

const TZ = 'Asia/Kolkata';
// Wednesday 11 November 2026, 10:00 IST
const NOW = new Date('2026-11-11T04:30:00.000Z');

function ref(text: string) {
  const refs = resolveDateRefs(text, TZ, NOW);
  return refs.map((r) => ({ phrase: r.phrase, date: r.primary.localDate, label: r.label, alts: r.alternates.map((a) => a.localDate) }));
}

const cases: Array<[string, string, string, string[]?]> = [
  ['On Monday we shortlisted 5 CRM tools', 'monday', '2026-11-09'],
  ['Last Tuesday I asked you about Postgres hosting', 'last tuesday', '2026-11-10', ['2026-11-03']],
  ['What did I ask you on 3 November?', '3 november', '2026-11-03'],
  ['what about yesterday', 'yesterday', '2026-11-10'],
  ['3 November 2025 pricing', '3 november 2025', '2025-11-03'],
];

for (const [text, phrase, expected, alts] of cases) {
  const refs = ref(text);
  const hit = refs.find((r) => r.phrase.includes(phrase));
  assert.ok(hit, `no ref found for "${phrase}" in: ${JSON.stringify(refs)}`);
  assert.equal(hit.date, expected, `wrong primary date for "${phrase}": ${JSON.stringify(hit)}`);
  if (alts) assert.deepEqual(hit.alts, alts, `wrong alternates for "${phrase}"`);
  console.log('ok', phrase, '->', hit.date, hit.alts.length ? `(alts ${hit.alts.join(',')})` : '');
}

// Today in IST is 2026-11-11 (04:30 UTC is 10:00 IST).
assert.equal(zonedParts(NOW, TZ).day, 11);
assert.equal(zonedParts(NOW, 'UTC').day, 11);

// Weekday resolution: "last Tuesday" on a Wednesday is the day before.
assert.equal(ref('last Tuesday')[0].date, '2026-11-10');
// A bare weekday resolves to the most recent occurrence.
assert.equal(ref('on Monday')[0].date, '2026-11-09');
// "this Tuesday" when today is Wednesday resolves to the most recent Tuesday too.
assert.equal(ref('this Tuesday')[0].date, '2026-11-10');

console.log('date resolver: all assertions passed');
