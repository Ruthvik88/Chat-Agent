/** Ignore protocol, www, query strings, fragments and trailing slashes when deduplicating pages. */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '') + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/** Official sources first, then relevance; keep the best copy of each page. */
export function rankSources<T extends { url: string; score?: number; official?: boolean }>(sources: T[], limit = 6): T[] {
  const ranked = [...sources].sort((a, b) => Number(!!b.official) - Number(!!a.official)
    || (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set<string>();
  return ranked.filter((s) => {
    const key = sourceKey(s.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
