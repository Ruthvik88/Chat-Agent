import './setup';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../src/config';
import { resolveDateRefs } from '../src/memory/dates';
import { renderReverifyContext, reverifyAnswer, type ReverifyReport } from '../src/memory/reverify';
import { SessionStore } from '../src/memory/store';
import type { SearchRequest, SearchResult } from '../src/search/types';

const TZ = 'Asia/Kolkata';
const SESSION = `test-reverify-${Date.now()}`;

/** Drains the re-verify generator and returns the final report. */
async function collectReport(opts: {
  llm: Parameters<typeof reverifyAnswer>[0]['llm'];
  search: Parameters<typeof reverifyAnswer>[0]['search'];
  store: SessionStore;
  question: string;
  dateRefs: ReturnType<typeof resolveDateRefs>;
  tz: string;
  now: Date;
}): Promise<ReverifyReport> {
  let report: ReverifyReport | undefined;
  for await (const event of reverifyAnswer(opts)) {
    if (event.type === 'report') report = event.report;
  }
  assert.ok(report, 'the re-verify flow must produce a report');
  return report;
}

/** A structured LLM that returns claims with the queries to check them. */
class StubLlm {
  calls: Array<{ system: string; text: string }> = [];

  async structured<T>(req: { system: string; turns: Array<{ text?: string }> }): Promise<T> {
    const text = req.turns[0]?.text ?? '';
    this.calls.push({ system: req.system, text });
    return {
      claims: [
        {
          claim: 'Neon starts at $19 per month',
          subject: 'Neon pricing',
          queries: ['Neon pricing per month', 'Neon pricing change 2026'],
        },
      ],
    } as unknown as T;
  }
}

class StubSearch {
  requests: SearchRequest[] = [];

  async search(req: SearchRequest): Promise<SearchResult[]> {
    this.requests.push(req);
    return [
      {
        title: 'Neon pricing update',
        url: 'https://neon.tech/pricing',
        content: 'Neon raised its entry price to $25 per month.',
        publishedDate: '2026-11-05',
      },
    ];
  }
}

/** An earlier answer with nothing checkable in it, so no claims come out. */
class NoClaimsLlm {
  async structured<T>(): Promise<T> {
    return { claims: [] } as unknown as T;
  }
}

/** The extraction call fails, which is not the same as an empty answer. */
class FailingLlm {
  async structured<T>(): Promise<T> {
    throw new Error('the model is out of quota');
  }
}

async function main() {
  const store = new SessionStore();
  await store.init();

  await store.append(SESSION, {
    ts: '2026-11-10T06:01:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month, Railway at $5 per month with usage pricing.',
  });

  const llm = new StubLlm();
  const search = new StubSearch();
  const now = new Date('2026-11-11T04:30:00.000Z');
  const question = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
  const dateRefs = resolveDateRefs(question, TZ, now);

  const report = await collectReport({
    llm,
    search,
    store,
    question,
    dateRefs,
    tz: TZ,
    now,
  });

  assert.equal(report.notFound, undefined, 'the earlier answer must be found');
  assert.equal(report.answerDate, '2026-11-10', 'the answer date must be the local day of the earlier answer');
  assert.equal(report.answeredAt, '2026-11-10T06:01:00.000Z');

  // Two searches per claim: a date-windowed one for things announced since the
  // answer, and a freshness one for pages edited in place (pricing pages).
  assert.equal(search.requests.length, 2);
  const windowed = search.requests.find((r) => r.startDate);
  assert.ok(windowed, 'expected a date-windowed search');
  assert.equal(windowed.startDate, '2026-11-10');
  assert.equal(windowed.endDate, '2026-11-11');
  assert.match(windowed.query, /Neon/);

  const fresh = search.requests.find((r) => r.maxAgeHours !== undefined);
  assert.ok(fresh, 'expected a freshness search');
  assert.equal(fresh.maxAgeHours, 24);
  assert.equal(fresh.startDate, undefined, 'a freshness search must not carry a date window');

  // The queries the model asked for are the ones used.
  assert.equal(windowed.query, "Neon serverless Postgres what's new since 2026-11-10 Neon pricing per month");
  assert.equal(windowed.topic, 'news');
  assert.equal(fresh.query, 'Neon serverless Postgres pricing');
  assert.deepEqual(fresh.includeDomains, ['neon.tech']);

  // The claim carries its raw evidence for the answer step to judge.
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].claim, 'Neon starts at $19 per month');
  assert.equal(report.checks[0].hasEvidence, true);
  assert.match(report.checks[0].evidence.join('\n'), /neon\.tech\/pricing/);
  assert.match(report.checks[0].evidence.join('\n'), /\$25/, 'the raw evidence must be passed through');

  // The extraction call must have received the earlier answer text.
  assert.match(llm.calls[0].text, /\$19 per month/);
  // And there is no separate verdict call any more.
  assert.equal(llm.calls.length, 1, 'there must be exactly one structured call');

  await rm(join(config.dataDir, 'sessions', `${SESSION}.jsonl`), { force: true });
  console.log('reverify: all assertions passed');
}

/** The answer chosen must match the topic, not just the day. */
async function testTopicMatching() {
  const store = new SessionStore();
  await store.init();
  const now = new Date('2026-11-11T04:30:00.000Z');

  // An unrelated answer on the same day as the referenced one.
  await store.append('a', {
    ts: '2026-11-10T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Supabase and Crunchy Bridge both work well for a small team.',
  });
  // The answer the user means, also on 10 Nov but later.
  await store.append('a', {
    ts: '2026-11-10T07:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month, Railway at $5 per month with usage pricing.',
  });

  const llm = new StubLlm();
  const search = new StubSearch();
  const question = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
  const report = await collectReport({
    llm,
    search,
    store,
    question,
    dateRefs: resolveDateRefs(question, TZ, now),
    tz: TZ,
    now,
  });

  // The Neon/Railway answer must be chosen, not the Supabase one.
  assert.match(llm.calls[0].text, /Neon/, `chose the wrong answer: ${llm.calls[0].text.slice(0, 120)}`);
  assert.doesNotMatch(llm.calls[0].text, /Crunchy/);

  await rm(join(config.dataDir, 'sessions', 'a.jsonl'), { force: true });
  console.log('reverify topic matching: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

testTopicMatching().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * An earlier answer with no checkable claims must be reported plainly: no
 * searches, no checks, and a context block that tells the model to say so.
 */
async function testNoCheckableClaims() {
  const store = new SessionStore();
  await store.init();
  await store.append('noclaims', {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Hey! How are you doing today?',
  });

  const llm = new NoClaimsLlm();
  const search = new StubSearch();
  const now = new Date('2026-11-11T04:30:00.000Z');

  const report = await collectReport({
    llm,
    search,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  });

  assert.equal(report.checks.length, 0, 'there is nothing to check');
  assert.equal(search.requests.length, 0, 'nothing checkable means no searches are spent');
  assert.equal(report.sameDay, undefined, 'this is not a same-day answer');
  assert.equal(report.notFound, undefined, 'the earlier answer was found');

  // The block must tell the model to say so plainly, not to search or invent.
  const block = renderReverifyContext(report);
  assert.match(block, /no checkable factual claims/i, 'the block must state that plainly');
  assert.match(block, /tell the user plainly/i, 'the block must ask for a plain answer');
  assert.doesNotMatch(block, /claim:/i, 'there must be no claim lines');

  await rm(join(config.dataDir, 'sessions', 'noclaims.jsonl'), { force: true });
  console.log('no checkable claims: all assertions passed');
}

testNoCheckableClaims().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * A failed extraction is not an answer with nothing in it. The user must not
 * be told that there was nothing to check when the check never ran.
 */
async function testExtractionFailureIsNotAnEmptyAnswer() {
  const store = new SessionStore();
  await store.init();
  await store.append('extractfail', {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Neon starts at $19 per month on its Launch plan.',
  });

  const llm = new FailingLlm();
  const search = new StubSearch();
  const now = new Date('2026-11-11T04:30:00.000Z');

  const report = await collectReport({
    llm,
    search,
    store,
    question: 'Has any pricing changed since then?',
    dateRefs: [],
    tz: TZ,
    now,
  });

  assert.equal(report.extractFailed, true, 'the failed extraction must be reported');
  assert.equal(report.checks.length, 0);
  assert.equal(search.requests.length, 0, 'no searches are spent when nothing was extracted');

  const block = renderReverifyContext(report);
  assert.match(block, /could not be checked/i, 'the block must say the check did not run');
  assert.doesNotMatch(
    block,
    /no checkable factual claims/i,
    'a failed extraction must not be reported as an empty answer',
  );

  await rm(join(config.dataDir, 'sessions', 'extractfail.jsonl'), { force: true });
  console.log('extraction failure: all assertions passed');
}

testExtractionFailureIsNotAnEmptyAnswer().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** Canned CRM regressions: coverage, same-value evidence, stale dates and display dates.
 * Verdict selection is an LLM instruction contract here; this is not a live model test.
 */
async function testCrmRegressions() {
  const store = new SessionStore();
  const sessionId = `crm-regressions-${Date.now()}`;
  const claims = ['HubSpot', 'Salesforce', 'Zoho', 'Pipedrive', 'Freshsales', 'Copper', 'Insightly'].map((subject) => ({
    subject,
    claim: subject === 'Pipedrive' ? 'Pipedrive Essentials is $24/user/month' : `${subject} offers CRM software`,
    queries: [`${subject} pricing`],
    vendorDomain: subject === 'Pipedrive' ? 'pipedrive.com' : '',
  }));
  await store.append(sessionId, {
    ts: '2026-11-09T03:30:00.000Z', tz: TZ, role: 'assistant', kind: 'message',
    text: claims.map((c) => c.claim).join('\n'),
  });
  const requests: SearchRequest[] = [];
  const search = { async search(req: SearchRequest): Promise<SearchResult[]> {
    requests.push(req);
    return [
      { title: 'Pricing', url: 'https://pipedrive.com/pricing', content: 'Essentials starts at $24 a seat a month.', publishedDate: 'Wed, 11 Nov 2026 21:00:00 GMT' },
      { title: 'Old pricing', url: 'https://example.com/old', content: 'Essentials starts at $30.', publishedDate: '2026-04-12' },
      { title: 'Undated pricing', url: 'https://example.com/undated', content: 'Essentials starts at $35.' },
      { title: 'Invalid date', url: 'https://example.com/invalid', content: 'Essentials starts at $40.', publishedDate: 'unknown' },
    ];
  } };
  try {
    for (const count of [5, 7]) {
      let extractionPrompt = '';
      let report!: ReverifyReport;
      for await (const event of reverifyAnswer({
        store, sessionId, search, question: 'Has any of them changed pricing or shipped something big since?',
        dateRefs: [], tz: TZ, now: new Date('2026-11-12T09:00:00+05:30'),
        llm: { async structured<T>(req: { system: string }): Promise<T> {
          extractionPrompt = req.system;
          return { claims: claims.slice(0, count) } as T;
        } },
      })) if (event.type === 'report') report = event.report;
      assert.match(extractionPrompt, /Do not cap extraction/);
      assert.equal(report.checks.length, Math.min(count, 6));
      assert.ok(report.checks.some((c) => c.subject === 'Freshsales'), 'fifth CRM must be checked');
      assert.deepEqual(report.uncheckedClaims, count === 7 ? ['Insightly offers CRM software'] : []);
      const context = renderReverifyContext(report);
      if (count === 7) assert.match(context, /NOT checked \(search cap\):\n- Insightly offers CRM software/);
      assert.match(context, /Unchanged ONLY when an OFFICIAL page excerpt states the same value/);
      assert.match(context, /Changed only when an official page OR a source dated after the original answer/);
      assert.match(context, /Every price\/number anywhere.*numbered source citation/);
      assert.match(context, /\[(?:OFFICIAL|background only); dated after original answer\].*\(11 Nov 2026\)/);
      assert.match(context, /\[background only; current page only; cannot establish changed since\].*\(12 Apr 2026\)/);
      assert.match(context, /\[background only; current page only; cannot establish changed since\].*\(undated\)/);
      assert.doesNotMatch(context, /Wed,|GMT|no date|\(unknown\)/);
      assert.ok(requests.some((r) => r.includeDomains?.[0] === 'pipedrive.com'));
      assert.equal(report.checks.find((c) => c.subject === 'Pipedrive')?.assessment?.verdict, 'Unchanged');
    }
    console.log('CRM canned regressions: five covered; overflow disclosed; same-value verdict instructions; stale/undated evidence labelled; dates formatted; official search requested');
  } finally {
    await rm(join(config.dataDir, 'sessions', `${sessionId}.jsonl`), { force: true });
  }
}

testCrmRegressions().catch((err) => { console.error(err); process.exit(1); });
