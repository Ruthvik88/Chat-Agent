import { rankSources, sourceKey } from '../search/results';
import { zonedParts, type DateRef } from './dates';
import { renderRecalledContext, tokenize } from './recall';
import type { SessionStore, Source, StoredTurn } from './store';

/** At most this many claims are re-verified per turn; each costs up to three searches. */
export const MAX_REVERIFY_CLAIMS = 6;

/** Progress of the re-verify flow, so the client can show what is happening. */
export type ReverifyEvent =
  | { type: 'status'; message: string; stage?: 'search' }
  | { type: 'report'; report: ReverifyReport };

export interface ClaimCheck {
  /** The claim as it was asserted in the earlier answer. */
  claim: string;
  subject: string;
  /** The queries used to check it. */
  queries: string[];
  /** Raw search results, trimmed, labelled by which search produced them. */
  evidence: string[];
  /** False when neither search returned anything for this claim. */
  hasEvidence: boolean;
}

export interface ReverifyReport {
  /** Absolute UTC timestamp of the answer being re-checked. */
  answeredAt: string;
  /** Local day of the original answer, YYYY-MM-DD. */
  answerDate: string;
  checks: ClaimCheck[];
  /** Extracted claims beyond the search cap, never silently omitted. */
  uncheckedClaims?: string[];
  /** URLs of the pages consulted while re-verifying. */
  sources: Source[];
  /** The queries this flow already ran, so the agent does not repeat them. */
  queries: string[];
  /** How long each stage took, in milliseconds. */
  timings: { extract_ms: number; search_ms: number };
  /** Set when the earlier answer could not be found. */
  notFound?: boolean;
  /**
   * Set when the earlier answer was given today. Nothing can have changed
   * since it, so no searches were run.
   */
  sameDay?: boolean;
  /**
   * Set when the claim extraction failed. The earlier answer may well have
   * checkable claims; the agent simply could not read them.
   */
  extractFailed?: boolean;
}

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'A single checkable factual statement.' },
          subject: { type: 'string', description: 'The product, company or topic the claim is about.' },
          vendorDomain: { type: 'string', description: 'Official vendor domain if confidently inferable, otherwise empty.' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'One or two web search queries that would confirm whether this claim still holds.',
          },
        },
        required: ['claim', 'subject', 'queries'],
      },
    },
  },
  required: ['claims'],
} as const;

const EXTRACT_SYSTEM = `You extract checkable factual claims from a previous answer so they can be re-verified against the web.
Rules:
- Only extract claims that are concrete and checkable (prices, versions, dates, feature statements, product names).
- Ignore opinions, hedges, and statements about the user's own data.
- Keep each claim to one sentence and preserve the exact asserted value.
- Extract *every* checkable claim, not just the first one. If the answer states a price for one
  product and a price for another, that is two claims and both must appear. A claim that is left out
  is never checked, and the user is never told about it.
- For each claim give one or two web search queries that would confirm whether it still holds.
  Every query must name the entity AND its product category to avoid homonyms, e.g. "Neon serverless Postgres pricing" or "Railway PaaS Postgres pricing". Include the category in subject too, so fallback and vendor-domain searches remain specific.
- Do not cap extraction: return all checkable claims so any claims beyond the search budget can be disclosed.
- For vendor claims, include vendorDomain when confidently inferable (e.g. Pipedrive: pipedrive.com, Freshsales: freshworks.com). Otherwise use an empty string. Never guess a domain.
- Return an empty list if the text contains no checkable claims.`;

interface LlmLike {
  structured<T>(req: {
    system: string;
    turns: Array<{ role: 'user' | 'assistant'; text?: string }>;
    responseSchema?: Record<string, unknown>;
  }): Promise<T>;
}

interface SearchLike {
  search(req: {
    query: string;
    startDate?: string;
    endDate?: string;
    topic?: 'general' | 'news';
    maxResults?: number;
    maxAgeHours?: number;
    includeDomains?: string[];
  }): Promise<Array<{ title: string; url: string; content: string; publishedDate?: string; score?: number; official?: boolean }>>;
}

/** Finds the assistant turn the user is most likely referring back to. */
/**
 * The words that signal a re-verify request. They are excluded when matching
 * an earlier answer, because every answer contains them: matching on "changed"
 * would pick any answer at all, not the one the user means.
 */
const REVERIFY_VOCABULARY = new Set([
  'still', 'correct', 'right', 'true', 'valid', 'accurate', 'same', 'changed',
  'change', 'changes', 'updated', 'update', 'updating', 'since', 'then', 'lately',
  'new', 'news', 'anything', 'newer', 'current', 'currently',
]);

/** Topic words for matching an earlier answer, without the re-verify wording. */
export function topicTokens(question: string): string[] {
  return tokenize(question).filter((t) => !REVERIFY_VOCABULARY.has(t));
}

/**
 * Picks the earlier answer the user is referring to.
 *
 * An answer must match on *both* axes to be a confident match: the day the
 * user named, and the topic they named. A date-only match can pick an
 * unrelated answer from the same day, so the topic decides between candidates.
 *
 * `topic` must exclude the re-verify vocabulary ("changed", "since", "still"),
 * or every answer matches on those words and the wrong one wins.
 *
 * `notBefore` excludes anything at or after the current turn: without it, the
 * answer to the question being asked now can be picked as the "earlier" one.
 */
function findEarlierAnswer(
  answers: StoredTurn[],
  tz: string,
  dateRefs: DateRef[],
  topic: string[],
  sessionId: string,
  notBefore: number,
): StoredTurn | null {
  const candidates = answers.filter((t) => new Date(t.ts).getTime() < notBefore);
  if (!candidates.length) return null;

  const targetDates = new Set<string>();
  for (const ref of dateRefs) {
    targetDates.add(ref.primary.localDate);
    for (const alt of ref.alternates) targetDates.add(alt.localDate);
  }

  const scored = candidates.map((turn) => {
    const p = zonedParts(new Date(turn.ts), turn.tz || tz);
    const key = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const dateMatch = targetDates.size > 0 && targetDates.has(key);
    const overlap = topic.length ? topic.filter((t) => tokenize(turn.text).includes(t)).length : 0;
    return { turn, dateMatch, overlap, key };
  });

  // Prefer answers that match the topic; among those, prefer the named day.
  const topicMatches = scored.filter((s) => s.overlap > 0);
  if (topicMatches.length) {
    const byDate = topicMatches.filter((s) => s.dateMatch);
    const pool = byDate.length ? byDate : topicMatches;
    pool.sort((a, b) => b.overlap - a.overlap || b.turn.ts.localeCompare(a.turn.ts));
    return pool[0].turn;
  }

  // No topical match: fall back to the named day.
  const byDate = scored.filter((s) => s.dateMatch);
  if (byDate.length) return byDate[byDate.length - 1].turn;

  // Nothing matched at all. "Since then" refers to the conversation the user
  // is having now, so prefer this session's own most recent answer before
  // reaching for one from another session.
  const ownSession = candidates.filter((t) => t.sessionId === sessionId);
  if (ownSession.length) return ownSession[ownSession.length - 1];
  return candidates[candidates.length - 1];
}

/** Every assistant answer across all sessions, oldest first. */
function allAnswers(store: SessionStore): StoredTurn[] {
  const out: StoredTurn[] = [];
  for (const sid of store.sessionIds()) {
    for (const turn of store.get(sid)) {
      if (turn.role === 'assistant' && turn.kind === 'message' && turn.text.trim()) out.push(turn);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Re-verifies an earlier answer: extract its claims, search the web with a
 * date filter starting at the original answer's timestamp, then classify each
 * claim as changed / unchanged / unverifiable.
 *
 * A generator so each stage can be reported to the client as it happens.
 */
export async function* reverifyAnswer(opts: {
  llm: LlmLike;
  search: SearchLike;
  store: SessionStore;
  sessionId: string;
  question: string;
  dateRefs: DateRef[];
  tz: string;
  now: Date;
}): AsyncGenerator<ReverifyEvent, void, void> {
  const { llm, search, store, sessionId, question, dateRefs, tz, now } = opts;

  // The earlier answer may live in any session on this machine, so search them all.
  // `now` bounds the search: an answer given at or after this moment is the
  // answer to the question being asked now, not the one being re-verified.
  const topic = topicTokens(question);
  const earlier = findEarlierAnswer(allAnswers(store), tz, dateRefs, topic, sessionId, now.getTime());

  const timings = { extract_ms: 0, search_ms: 0 };

  if (!earlier) {
    yield {
      type: 'report',
      report: {
        answeredAt: now.toISOString(),
        answerDate: '',
        checks: [],
        sources: [],
        queries: [],
        timings,
        notFound: true,
      },
    };
    return;
  }

  const p = zonedParts(new Date(earlier.ts), earlier.tz || tz);
  const answerDate = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const today = zonedParts(now, tz);
  const todayStr = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;

  // Same-day guard: the answer was given today, so nothing can have changed
  // since it. Searching would only find the pages that produced it, so no
  // searches are run and the user is offered a fresh search instead.
  if (answerDate === todayStr) {
    yield {
      type: 'status',
      message: 'Your earlier answer was from today, so there is nothing that could have changed since then',
    };
    yield {
      type: 'report',
      report: {
        answeredAt: earlier.ts,
        answerDate,
        checks: [],
        sources: [],
        queries: [],
        timings,
        sameDay: true,
      },
    };
    return;
  }

  // 1. Extract the checkable claims, and the queries to check them, in one call.
  yield { type: 'status', message: 'Checking your earlier answer…' };
  const extractStart = Date.now();
  let claims: Array<{ claim: string; subject: string; queries: string[]; vendorDomain?: string }> = [];
  let uncheckedClaims: string[] = [];
  // A failed extraction is not the same as an answer with nothing in it, and
  // the user must not be told the second when it is the first.
  let extractFailed = false;
  try {
    const extracted = await llm.structured<{
      claims: Array<{ claim: string; subject: string; queries: string[]; vendorDomain?: string }>;
    }>({
      system: EXTRACT_SYSTEM,
      turns: [{ role: 'user', text: `Previous answer:\n\n${earlier.text}` }],
      responseSchema: CLAIM_SCHEMA as unknown as Record<string, unknown>,
    });
    claims = (extracted.claims ?? [])
      .map((c) => ({
        claim: c.claim,
        subject: c.subject,
        vendorDomain: c.vendorDomain?.trim().toLowerCase(),
        queries: (c.queries ?? []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 2),
      }))
      .filter((c) => c.claim?.trim());
    uncheckedClaims = claims.slice(MAX_REVERIFY_CLAIMS).map((c) => c.claim);
    claims = claims.slice(0, MAX_REVERIFY_CLAIMS);
  } catch {
    extractFailed = true;
    claims = [];
  }
  timings.extract_ms = Date.now() - extractStart;

  if (!claims.length) {
    yield {
      type: 'report',
      report: {
        answeredAt: earlier.ts,
        answerDate,
        checks: [],
        sources: [],
        queries: [],
        timings,
        extractFailed,
      },
    };
    return;
  }

  // 2. Gather evidence.
  //
  // Two complementary searches per claim, because Tavily's date window filters
  // on a page's *publish* date:
  //   a) a date-windowed search finds things *announced* since the answer;
  //   b) a freshness search (max_age_hours, no window) reads the *current*
  //      content of pages that are edited in place, such as pricing pages,
  //      which a publish-date window would otherwise drop.
  const perClaim: Array<{ claim: string; subject: string; hits: Array<{ key: string; text: string }> }> = [];
  const sources: Source[] = [];

  yield {
    type: 'status',
    stage: 'search',
    message: `Searching for changes to ${claims.length} claim${claims.length === 1 ? '' : 's'} since ${answerDate}`,
  };

  // All claims are searched concurrently.
  const searchStart = Date.now();
  const queries: string[] = [];
  await Promise.all(
    claims.map(async (c) => {
      const hits: Array<{ key: string; text: string }> = [];
      const seenPages = new Set<string>();
      const collect = (label: string, results: Awaited<ReturnType<typeof search.search>>) => {
        for (const r of rankSources(results, 5)) {
          const key = sourceKey(r.url);
          if (seenPages.has(key)) continue;
          seenPages.add(key);
          const date = r.publishedDate ? new Date(r.publishedDate) : null;
          const inWindow = date && Number.isFinite(date.getTime())
            && date.getTime() > new Date(earlier.ts).getTime() && date.getTime() <= now.getTime();
          const timing = inWindow ? 'dated after original answer' : 'current page only; cannot establish changed since';
          hits.push({ key, text: `${label} [${timing}] ${r.title} (${formatEvidenceDate(r.publishedDate)}) ${r.url}\n${r.content.slice(0, 500)}` });
          sources.push({ title: r.title, url: r.url, publishedDate: r.publishedDate, score: r.score, official: r.official });
        }
      };

      // The model supplied the queries; fall back to the subject if it did not.
      const windowedQuery = c.queries[0] ?? `${c.subject} ${c.claim}`;
      const freshQuery = c.queries[1] ?? `${c.subject} pricing current`;
      queries.push(windowedQuery, freshQuery);

      const domain = c.vendorDomain && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(c.vendorDomain)
        ? c.vendorDomain : undefined;
      if (domain) queries.push(`${c.subject} pricing current site:${domain}`);
      const [windowed, fresh, official] = await Promise.allSettled([
        search.search({
          query: windowedQuery,
          startDate: answerDate,
          endDate: todayStr,
          topic: 'general',
          maxResults: 5,
        }),
        search.search({
          query: freshQuery,
          maxAgeHours: 24,
          topic: 'general',
          maxResults: 4,
        }),
        ...(domain ? [search.search({
          query: `${c.subject} pricing current site:${domain}`,
          includeDomains: [domain],
          maxAgeHours: 24,
          topic: 'general',
          maxResults: 4,
        })] : []),
      ]);

      if (official?.status === 'fulfilled') collect('[vendor-domain search]', official.value);
      if (windowed.status === 'fulfilled') collect('[date-window search]', windowed.value);
      if (fresh.status === 'fulfilled') collect('[current page]', fresh.value);
      // A search failure for one claim must not sink the whole report.
      perClaim.push({ claim: c.claim, subject: c.subject, hits });
    }),
  );
  timings.search_ms = Date.now() - searchStart;

  // 3. No verdict call: the claims and their raw evidence go to the answer
  //    model, which reports changed / unchanged / could not verify itself.
  const selectedSources = rankSources(sources);
  const selectedKeys = new Set(selectedSources.map((s) => sourceKey(s.url)));
  const checks: ClaimCheck[] = claims.map((c) => {
    const hits = perClaim.find((p) => p.claim === c.claim)?.hits ?? [];
    return {
      claim: c.claim,
      subject: c.subject,
      queries: c.queries,
      evidence: hits.filter((h) => selectedKeys.has(h.key)).map((h) => h.text),
      hasEvidence: hits.some((h) => selectedKeys.has(h.key)),
    };
  });

  yield {
    type: 'report',
    report: {
      answeredAt: earlier.ts,
      answerDate,
      checks,
      uncheckedClaims,
      sources: selectedSources,
      queries,
      timings,
    },
  };
}

function formatEvidenceDate(value?: string): string {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'undated';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Renders a re-verify report into a context block for the model. */
export function renderReverifyContext(report: ReverifyReport): string {
  if (report.notFound) {
    return [
      '<reverify>',
      'No earlier answer from this user was found for the referenced date, so there is nothing to re-verify.',
      'Tell the user plainly that you could not find that earlier conversation.',
      '</reverify>',
    ].join('\n');
  }
  if (report.sameDay) {
    return [
      '<reverify>',
      `The earlier answer was given today (${report.answerDate}), so nothing can have changed since it.`,
      'No search was run for this. Tell the user that, and offer to run a fresh search for the',
      'current state of the topic instead — they can simply ask.',
      '</reverify>',
    ].join('\n');
  }
  if (report.extractFailed) {
    return [
      '<reverify>',
      `The earlier answer from ${report.answeredAt} could not be checked, because reading its claims failed.`,
      'Say so plainly: the earlier answer may still contain checkable claims, but the check could not be',
      'run. Do not say that there was nothing to check, and do not guess at what changed.',
      'Offer to try again, or to search for the current state of the topic.',
      '</reverify>',
    ].join('\n');
  }
  if (!report.checks.length) {
    return [
      '<reverify>',
      `The earlier answer from ${report.answeredAt} contains no checkable factual claims, so there is nothing to re-verify.`,
      'Tell the user plainly that the earlier answer has no checkable claims, so nothing could be',
      'checked against the web. Do not guess at what might have changed, and do not search for it:',
      'offer to run a fresh search for the current state of the topic instead — they can simply ask.',
      '</reverify>',
    ].join('\n');
  }
  const evidencePages = new Map<string, number>();
  const lines = report.checks.map((c) => {
    const evidence = c.evidence.length
      ? c.evidence.map((e) => {
        const url = e.match(/https?:\/\/\S+/)?.[0];
        const key = url ? sourceKey(url) : e;
        const existing = evidencePages.get(key);
        if (existing) return `    See evidence source ${existing} above (same page, not another result).`;
        const id = evidencePages.size + 1;
        evidencePages.set(key, id);
        return `    Evidence source ${id}: ${e}`;
      }).join('\n')
      : '    (no search results for this claim)';
    return `- Claim: ${c.claim}\n  Evidence:\n${evidence}`;
  });
  return [
    '<reverify>',
    `The user's earlier answer, given at ${report.answeredAt} (local day ${report.answerDate}), was checked`,
    'against fresh web search results.',
    'Report the result as a markdown table with exactly three columns: Claim, Verdict, Evidence.',
    'One row per checked claim. If there are unchecked claims listed below, add a sentence after the table naming every one as NOT checked; otherwise no intro or summary.',
    'The Verdict cell is exactly one of: Changed, Unchanged, Could not verify.',
    'Unchanged when evidence restates the same value (including equivalent seat/user and month wording).',
    'Changed only when evidence states a different value AND is dated after the original answer, within the checking window.',
    'Evidence that is undated or older than the answer can support current page says X, never changed since.',
    'Otherwise use Could not verify. A different plan name alone does not prove a price changed.',
    'For each row consult vendor-domain search evidence first. Cite a relevant official vendor page in preference to blogs or forums, even if the vendor page is undated or older (it can confirm a current value). Use third-party evidence only if official evidence does not address the claim.',
    'Every price/number anywhere in the answer (including Claim cells) must carry a supporting source link; otherwise drop it or explicitly mark it unverified.',
    'The Evidence cell gives the date as 12 Nov 2026 (or undated) and a markdown link to the source URL.',
    'If a claim has no evidence at all, its verdict is Could not verify — never guess.',
    ...lines,
    ...(report.uncheckedClaims?.length ? ['NOT checked (search cap):', ...report.uncheckedClaims.map((c) => `- ${c}`)] : []),
    'Final output check: every price/number must have a supporting markdown link in its cell or be explicitly labelled unverified. Use the formatted evidence dates above. Prefer relevant official vendor evidence. Do not add a summary or claim there were no releases: absence of search evidence does not establish that nothing shipped. Name every NOT checked claim after the table if any were listed.',
    '</reverify>',
  ].join('\n');
}

export { renderRecalledContext };
