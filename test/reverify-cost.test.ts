import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../src/config';
import { MAX_REVERIFY_CLAIMS, reverifyAnswer } from '../src/memory/reverify';
import { SessionStore } from '../src/memory/store';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import type { SearchProvider, SearchRequest, SearchResult } from '../src/search/types';

const TZ = 'Asia/Kolkata';

/** Returns N claims, so the cost of a re-verify can be measured. */
class ClaimLlm implements LlmProvider {
  readonly name = 'claims';
  readonly model = 'claims';

  readonly primaryModel = 'primary-model';
  readonly stats = { retries: 0, fallbackUsed: false };
  private n = 0;

  constructor(private readonly claimCount: number) {}

  async *stream(req: LlmRequest): AsyncIterable<never> {
    yield { type: 'text', text: '' };
  }

  async structured<T>(): Promise<T> {
    this.n++;
    return {
      claims: Array.from({ length: this.claimCount }, (_, i) => ({
        claim: `Claim ${i + 1}`,
        subject: `Subject ${i + 1}`,
        queries: [`query ${i + 1}`],
      })),
    } as unknown as T;
  }
}

class CountingSearch implements SearchProvider {
  readonly name = 'counting';
  requests: SearchRequest[] = [];

  async search(req: SearchRequest): Promise<SearchResult[]> {
    this.requests.push(req);
    return [];
  }
}

async function main() {
  const store = new SessionStore();
  await store.init();
  // A distinctive subject, so this test's answer is not confused with an
  // answer left behind by another suite (recall searches every session).
  await store.append('cost', {
    ts: '2026-11-05T06:00:00.000Z',
    tz: TZ,
    role: 'assistant',
    kind: 'message',
    text: 'Zebramqote hosting starts at $19 per month.',
  });

  console.log('claims | searches | searches/claim | credits (basic=1)');
  for (const claimCount of [1, 3, 4, 8]) {
    const search = new CountingSearch();
    for await (const _ of reverifyAnswer({
      sessionId: 'reverify-test',
      llm: new ClaimLlm(claimCount),
      search,
      store,
      question: 'Has any pricing changed since then?',
      dateRefs: [],
      tz: TZ,
      now: new Date('2026-11-12T09:00:00.000Z'),
    })) {
      // drain
    }
    const searched = Math.min(claimCount, MAX_REVERIFY_CLAIMS);
    console.log(
      `${String(claimCount).padStart(6)} | ${String(search.requests.length).padStart(8)} | ${(
        search.requests.length / searched
      ).toFixed(1).padStart(14)} | ${String(search.requests.length).padStart(19)}`,
    );
    // Every claim costs one windowed search and one freshness search.
    assert.equal(search.requests.length, searched * 2, 'two searches per claim');
    const windowed = search.requests.filter((r) => r.startDate);
    assert.equal(windowed.length, searched, 'one windowed search per claim');
    const fresh = search.requests.filter((r) => r.maxAgeHours !== undefined);
    assert.equal(fresh.length, searched, 'one freshness search per claim');
  }

  console.log('\nMAX_REVERIFY_CLAIMS =', MAX_REVERIFY_CLAIMS);
  console.log('without inferred vendor domains per re-verify =', MAX_REVERIFY_CLAIMS * 2, 'Tavily calls');
  console.log('at search_depth=basic that is', MAX_REVERIFY_CLAIMS * 2, 'credits');
  console.log('with inferred vendor domains: up to', MAX_REVERIFY_CLAIMS * 3, 'Tavily calls (before capacity retries)');
  await rm(join(config.dataDir, 'sessions', 'cost.jsonl'), { force: true });
  console.log('reverify cost: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
