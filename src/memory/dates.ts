/**
 * Deterministic relative-date resolver.
 *
 * Everything is computed in the user's timezone (default Asia/Kolkata) with no
 * LLM involvement, so "last Tuesday" always means the same thing.
 */

import { currentTime } from '../config';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

export interface DateCandidate {
  /** Local calendar day in the user's timezone, YYYY-MM-DD. */
  localDate: string;
  /** Inclusive UTC bounds of that local day. */
  startUtc: string;
  endUtc: string;
}

export type DateRefKind = 'day' | 'range';

export interface DateRef {
  /** The matched substring of the user message. */
  phrase: string;
  kind: DateRefKind;
  /** Best interpretation. */
  primary: DateCandidate;
  /** Other plausible readings (e.g. "last Tuesday" the week before). */
  alternates: DateCandidate[];
  /** Human label, e.g. "Tuesday 10 Nov 2026". */
  label: string;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function partsFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function timeFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Wall-clock parts of `instant` in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = timeFormatter(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    weekday: new Date(Date.UTC(get('year'), get('month') - 1, get('day'))).getUTCDay(),
  };
}

/** UTC offset of `tz` at `instant`, in milliseconds. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight for a (year, month, day) in `tz`. */
export function localDayStartUtc(year: number, month: number, day: number, tz: string): Date {
  // Offset can shift across DST boundaries, so resolve it iteratively.
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(new Date(guess), tz);
    const next = Date.UTC(year, month - 1, day) - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function localDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function candidateFor(year: number, month: number, day: number, tz: string): DateCandidate {
  const start = localDayStartUtc(year, month, day, tz);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1);
  return {
    localDate: localDateString(year, month, day),
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
  };
}

function addDays(year: number, month: number, day: number, delta: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** The most recent occurrence of `weekday` on or before today. */
function mostRecentWeekday(today: ZonedParts, weekday: number): [number, number, number] {
  const delta = (today.weekday - weekday + 7) % 7;
  return addDays(today.year, today.month, today.day, -delta);
}

function formatLabel(year: number, month: number, day: number): string {
  const name = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${name[0].toUpperCase()}${name.slice(1)} ${day} ${MONTHS[month - 1][0].toUpperCase()}${MONTHS[month - 1].slice(1)} ${year}`;
}

/**
 * Finds every date reference in `text` and resolves it to concrete local days.
 */
export function resolveDateRefs(text: string, tz: string, now: Date = currentTime()): DateRef[] {
  const today = zonedParts(now, tz);
  const lower = text.toLowerCase();
  const refs: DateRef[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  const add = (ref: DateRef, start: number, end: number) => {
    if (!overlaps(start, end)) {
      claimed.push([start, end]);
      refs.push(ref);
    }
  };

  // "today" / "yesterday" / "N days ago"
  const relativeDay = /(?:\b(today)\b|\b(yesterday)\b|\b(\d+)\s+days?\s+ago\b)/g;
  for (const m of lower.matchAll(relativeDay)) {
    const [y, mo, d] =
      m[1] !== undefined
        ? ([today.year, today.month, today.day] as [number, number, number])
        : m[2] !== undefined
          ? addDays(today.year, today.month, today.day, -1)
          : addDays(today.year, today.month, today.day, -Number(m[3]));
    const c = candidateFor(y, mo, d, tz);
    add(
      {
        phrase: m[0],
        kind: 'day',
        primary: c,
        alternates: [],
        label: formatLabel(y, mo, d),
      },
      m.index!,
      m.index! + m[0].length,
    );
  }

  // "last <weekday>" and bare "<weekday>"
  const weekdayRe = new RegExp(
    `\\b(?:(last|this)\\s+)?(${WEEKDAYS.join('|')})\\b`,
    'g',
  );
  for (const m of lower.matchAll(weekdayRe)) {
    const qualifier = m[1];
    const weekday = WEEKDAYS.indexOf(m[2]);
    const [ry, rm, rd] = mostRecentWeekday(today, weekday);
    const primary = candidateFor(ry, rm, rd, tz);
    const alternates: DateCandidate[] = [];
    if (qualifier === 'last') {
      // "last Tuesday" also plausibly means the Tuesday a week earlier.
      const [ay, am, ad] = addDays(ry, rm, rd, -7);
      alternates.push(candidateFor(ay, am, ad, tz));
    }
    add(
      {
        phrase: m[0],
        kind: 'day',
        primary,
        alternates,
        label: formatLabel(ry, rm, rd),
      },
      m.index!,
      m.index! + m[0].length,
    );
  }

  // "3 November" / "November 3rd" / "3 Nov 2025"
  const monthNames = MONTHS.map((m) => m.slice(0, 3)).join('|');
  const mdRe = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})(${monthNames})?(?:,?\\s*(\\d{4}))?\\b` +
      `|\\b(${MONTHS.join('|')})(${monthNames})?\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
    'g',
  );
  for (const m of lower.matchAll(mdRe)) {
    const day = Number(m[1] ?? m[7]);
    const monthName = m[2] ?? m[5];
    const month = MONTHS.findIndex((x) => x === monthName || x.slice(0, 3) === monthName) + 1;
    const year = Number(m[4] ?? m[8] ?? 0);
    if (!month || !day) continue;

    let y: number;
    if (year) {
      y = year;
    } else {
      // Assume the most recent occurrence of that calendar date.
      y = today.year;
      const thisYear = candidateFor(y, month, day, tz);
      if (thisYear.startUtc > now.toISOString()) {
        y = today.year - 1;
      }
    }
    const primary = candidateFor(y, month, day, tz);
    add(
      {
        phrase: m[0],
        kind: 'day',
        primary,
        alternates: [],
        label: formatLabel(y, month, day),
      },
      m.index!,
      m.index! + m[0].length,
    );
  }

  // "last week" / "this week"
  const rangeRe = /\b(last|this)\s+(week|month)\b/g;
  for (const m of lower.matchAll(rangeRe)) {
    const dir = m[1];
    const unit = m[2];
    let start: [number, number, number];
    let end: [number, number, number];
    if (unit === 'week') {
      const weekStartOffset = (today.weekday + 6) % 7; // Monday-based
      const thisWeekStart = addDays(today.year, today.month, today.day, -weekStartOffset);
      start = dir === 'last' ? addDays(...thisWeekStart, -7) : thisWeekStart;
      end = dir === 'last' ? addDays(...thisWeekStart, -1) : addDays(...thisWeekStart, 6);
    } else {
      const thisMonthStart: [number, number, number] = [today.year, today.month, 1];
      if (dir === 'last') {
        const lastMonth = today.month === 1 ? 12 : today.month - 1;
        const lastYear = today.month === 1 ? today.year - 1 : today.year;
        start = [lastYear, lastMonth, 1];
        end = [lastYear, lastMonth, new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate()];
      } else {
        start = thisMonthStart;
        end = [today.year, today.month, new Date(Date.UTC(today.year, today.month, 0)).getUTCDate()];
      }
    }
    const startUtc = localDayStartUtc(start[0], start[1], start[2], tz);
    const endUtc = localDayStartUtc(end[0], end[1], end[2], tz).getTime() + 24 * 3600 * 1000 - 1;
    add(
      {
        phrase: m[0],
        kind: 'range',
        primary: {
          localDate: localDateString(start[0], start[1], start[2]),
          startUtc: startUtc.toISOString(),
          endUtc: new Date(endUtc).toISOString(),
        },
        alternates: [],
        label: `${m[0]} (${formatLabel(start[0], start[1], start[2])} – ${formatLabel(end[0], end[1], end[2])})`,
      },
      m.index!,
      m.index! + m[0].length,
    );
  }

  return refs.sort((a, b) => a.primary.startUtc.localeCompare(b.primary.startUtc));
}
