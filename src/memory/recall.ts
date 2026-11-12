import { zonedParts, type DateRef } from './dates';
import type { SessionStore, StoredTurn } from './store';

export interface RecalledTurn {
  turn: StoredTurn;
  /** Local day in the user's timezone, YYYY-MM-DD. */
  localDate: string;
  score: number;
  /** Why this turn was selected, for the injected context header. */
  reason: 'date' | 'topic';
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'i', 'you', 'me', 'my', 'we', 'our', 'to', 'of', 'in', 'on', 'at', 'for', 'and',
  'or', 'if', 'so', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'have',
  'has', 'had', 'with', 'about', 'from', 'by', 'as', 'any', 'still', 'since',
  'then', 'what', 'when', 'who', 'how', 'there', 'here', 'tell', 'me', 'again',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.+-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** A turn with the local day it belongs to, plus the session it came from. */
interface IndexedTurn {
  turn: StoredTurn;
  localDate: string;
  sameSession: boolean;
}

/**
 * Deterministic lexical retrieval over past turns, across **all** sessions.
 *
 * Ranking, in order:
 *  1. turns whose local day falls inside a resolved date range, ranked by
 *     lexical overlap with the query;
 *  2. if nothing in the date range matches lexically, the most recent turns
 *     in that range;
 *  3. otherwise the best lexical matches anywhere.
 */
export async function recall(
  sessionStore: SessionStore,
  sessionId: string,
  query: string,
  tz: string,
  dateRefs: DateRef[],
  limit = 6,
  exclude?: Set<string>,
): Promise<RecalledTurn[]> {
  const queryTokens = tokenize(query);
  const targetDates = new Set<string>();
  for (const ref of dateRefs) {
    targetDates.add(ref.primary.localDate);
    for (const alt of ref.alternates) targetDates.add(alt.localDate);
  }

  // Pick up any session file added since the last call.
  await sessionStore.refresh();

  // Every session on this machine, current one first.
  const sessions = [sessionId, ...sessionStore.sessionIds().filter((s) => s !== sessionId)];
  const all: Array<{ turn: StoredTurn; localDate: string; sameSession: boolean }> = [];
  for (const sid of sessions) {
    for (const turn of sessionStore.get(sid)) {
      if (turn.kind !== 'message') continue;
      const p = zonedParts(new Date(turn.ts), turn.tz || tz);
      all.push({
        turn,
        localDate: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
        sameSession: sid === sessionId,
      });
    }
  }
  if (!all.length) return [];

  // Document frequency for IDF weighting.
  const df = new Map<string, number>();
  for (const item of all) {
    for (const token of new Set(tokenize(item.turn.text))) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const n = all.length;

  const scored: Array<IndexedTurn & { topic: number; dateHit: boolean }> = [];
  for (const item of all) {
    const dateHit = targetDates.has(item.localDate);
    // Turns already replayed as conversation history are skipped, unless they
    // fall on the day the user asked about: the replayed history carries no
    // timestamps, so `<past_turns>` is the only place the date is visible.
    if (!dateHit && exclude?.has(item.turn.ts)) continue;
    const counts = new Map<string, number>();
    for (const t of tokenize(item.turn.text)) counts.set(t, (counts.get(t) ?? 0) + 1);

    let topic = 0;
    for (const q of queryTokens) {
      const count = counts.get(q);
      if (!count) continue;
      const idf = Math.log(1 + n / (1 + (df.get(q) ?? 0)));
      topic += idf * (1 + Math.log(count));
    }
    topic /= Math.sqrt(queryTokens.length || 1);

    scored.push({ ...item, topic, dateHit });
  }

  const byRecency = (a: IndexedTurn, b: IndexedTurn) => b.turn.ts.localeCompare(a.turn.ts);
  const byLexical = (a: { topic: number; sameSession: boolean }, b: { topic: number; sameSession: boolean }) =>
    b.topic - a.topic || Number(b.sameSession) - Number(a.sameSession);
  const toResult = (s: IndexedTurn & { topic: number; dateHit: boolean }, reason: 'date' | 'topic'): RecalledTurn => ({
    turn: s.turn,
    localDate: s.localDate,
    score: s.topic + (s.sameSession ? 0.5 : 0),
    reason,
  });

  // 1. The date range comes first; within it, lexical overlap decides.
  const inRange = scored.filter((s) => s.dateHit);
  if (inRange.length) {
    const lexical = inRange.filter((s) => s.topic >= 0.15);
    const pool = lexical.length ? lexical : inRange;
    const sorted = lexical.length ? [...pool].sort(byLexical) : [...pool].sort(byRecency);
    return sorted.slice(0, limit).map((s) => toResult(s, 'date'));
  }

  // 2. No turn on the named day: the best lexical match anywhere.
  const lexical = scored.filter((s) => s.topic >= 0.15).sort(byLexical);
  if (lexical.length) {
    return lexical.slice(0, limit).map((s) => toResult(s, 'topic'));
  }

  // 3. Nothing matched lexically: the most recent turns, so context is not empty.
  return [...scored].sort(byRecency).slice(0, limit).map((s) => toResult(s, 'topic'));
}

/**
 * Renders recalled turns into a block that is injected into the model context.
 * Absolute UTC timestamps are always included alongside the local day.
 */
export function renderRecalledContext(recalled: RecalledTurn[], tz: string): string {
  if (!recalled.length) return '';
  const lines = recalled.map((r) => {
    const p = zonedParts(new Date(r.turn.ts), tz);
    const local = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const who = r.turn.role === 'user' ? 'user' : 'assistant';
    return `- [${r.turn.ts} | local ${local} ${tz} | matched by ${r.reason}] ${who}: ${r.turn.text}`;
  });
  return [
    '<past_turns>',
    'Earlier turns from this user\'s conversation history. Absolute UTC timestamps are given first;',
    'the local day is derived from them, so never re-derive dates from the text alone.',
    ...lines,
    '</past_turns>',
  ].join('\n');
}
