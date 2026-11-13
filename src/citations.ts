import type { Source } from './memory/store';

export interface CitationCheck {
  /** Character offset of the [n] marker in the streamed answer. */
  offset: number;
  id: number;
  entity: string;
  verified: boolean;
  reason?: string;
}

const aliases: Record<string, string[]> = {
  Neon: ['neon'], Railway: ['railway'], Render: ['render'],
  Pipedrive: ['pipedrive'], Freshsales: ['freshsales'],
  'Oracle Siebel': ['oracle siebel', 'siebel'], HubSpot: ['hubspot', 'hub spot'],
  Salesforce: ['salesforce'], Zoho: ['zoho'], Copper: ['copper'], Insightly: ['insightly'],
  'Node.js': ['node.js', 'nodejs'],
};
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const contains = (text: string, name: string) => (` ${normalize(text)} `).includes(` ${normalize(name)} `);
const namesFor = (entity: string) => aliases[entity] ?? [entity];
const matches = (text: string, entity: string) => namesFor(entity).some((a) => contains(text, a));

/** Vendor/product names, with conservative support for previously unseen capitalized names. */
export function entitiesIn(text: string): string[] {
  const known = Object.keys(aliases).filter((name) => matches(text, name));
  if (known.length) return known;
  const generic = /^(The|A|An|This|That|It|Its|For|From|Based|According|Current|Latest|Pricing|Price|Plan|Plans|Free|Launch|Scale|Starter|Standard|Growth|Essentials|Compute|Storage|RAM|CPU|GB|CU|USD|Unchanged|Changed|Could|Evidence|Claim|Verdict|Source|Sources|I|No|Yes|However|Pay|Use|Monthly|Annual|Pro|Hobby|Tier|Unit|Units|Geared|Paid|Minimum|Fees|Monthly)$/i;
  const extra = text.match(/\b[A-Z][a-zA-Z0-9]*(?:\.[a-z]+)?\b/g) ?? [];
  return [...new Set([...known, ...extra.filter((word) => !generic.test(word)
    && !known.some((name) => matches(word, name)) && word.length > 2)])];
}

export function formatSourceDate(value?: string): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'undated';
}

/** URLs stay on the server/client side, never in the retrieved model context. */
export function modelSource(source: Source) {
  let domain = source.domain ?? '';
  try { domain = new URL(source.url).hostname; } catch { /* invalid sources cannot become links */ }
  return { id: source.id, citation: `[${source.id}]`, title: withoutUrls(source.title), domain,
    publishedDate: formatSourceDate(source.publishedDate), excerpt: withoutUrls(source.excerpt ?? '').slice(0, 500) };
}

export function withoutUrls(text: string): string {
  return text.replace(/\[([^\]]*)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/g, '(URL omitted)');
}

/** Identity/attribution check, not a proof that a price or other value is correct. */
export function sourceMatchesEntity(source: Source, entity: string, claim: string): boolean {
  const excerpt = (source.excerpt ?? '').replace(/^.*(?:compare:|read more|see also).*$/gim, '');
  if (!matches(`${source.title} ${source.url} ${excerpt}`, entity)) return false;
  // Publisher names in a comparison page cannot turn another vendor's price into this vendor's price.
  const others = Object.keys(aliases).filter((name) => name !== entity && matches(excerpt, name));
  if (others.length && !matches(excerpt, entity)) return false;
  if (/\$|\b(?:price|pricing|cost|per month|per user)\b/i.test(claim) && !matches(excerpt, entity)) {
    const title = source.title.replace(/\s*[|–—-]\s*[^|–—-]+$/, '');
    let pricingPage = false;
    try { pricingPage = /\/(?:[^/]+\/)*pricing(?:\/|$)/i.test(new URL(source.url).pathname); } catch {}
    if (!matches(title, entity) && !pricingPage) return false;
  }
  return true;
}

/** Recomputed incrementally; text is never held while waiting for a complete claim. */
export function checkCitations(text: string, sources: Source[]): CitationCheck[] {
  const checks: CitationCheck[] = [];
  let previousEnd = 0;
  let headingEntities: string[] = [];
  let lineStart = 0;
  let previousTargets: string[] = [];
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) headingEntities = entitiesIn(line.replace(/^#+\s*/, ''));
    for (const match of line.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      const offset = lineStart + match.index!;
      const start = Math.max(lineStart, previousEnd);
      const claim = text.slice(start, offset).replace(/\*|`/g, '');
      const entities = entitiesIn(claim);
      const explicit = entities.filter((e) => e in aliases);
      const targets = explicit.length ? explicit : /^[\s.*|,;:]*$/.test(claim) && previousTargets.length
        ? previousTargets : headingEntities.length ? headingEntities : entities.length ? entities : previousTargets;
      previousTargets = targets;
      for (const id of match[1].split(',').map(Number)) {
        const source = sources.find((s) => s.id === id);
        const verified = !!source && targets.length > 0 && targets.every((e) => sourceMatchesEntity(source, e, claim));
        checks.push({ offset, id, entity: targets.join(', '), verified,
          ...(!verified ? { reason: !source ? 'unknown source' : !targets.length ? 'entity not specified' : 'entity or attribution mismatch' } : {}) });
      }
      previousEnd = offset + match[0].length;
    }
    lineStart += line.length + 1;
  }
  return checks;
}
