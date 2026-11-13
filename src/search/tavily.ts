import { rankSources } from './results';
import { config } from '../config';
import { SearchError, type SearchProvider, type SearchRequest, type SearchResult } from './types';

/** Precision-first cutoff for narrow entity searches; scores are not probabilities. */
export const MIN_RELEVANCE_SCORE = 0.6;

/**
 * Tavily Search adapter.
 *
 * A second provider (Exa, Brave, ...) only needs to implement SearchProvider and
 * be registered in src/search/index.ts.
 *
 * Request fields are limited to those in Tavily's published OpenAPI schema for
 * POST /search (verified against https://docs.tavily.com/documentation/api-reference/openapi.json).
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';

  constructor(
    private readonly apiKey = config.tavilyApiKey,
    private readonly baseUrl = config.tavilyBaseUrl,
  ) {}

  async search(req: SearchRequest): Promise<SearchResult[]> {
    if (!this.apiKey) throw new SearchError('TAVILY_API_KEY is not set');

    const body: Record<string, unknown> = {
      query: req.query,
      // basic is 1 credit, advanced is 2.
      search_depth: 'basic',
      topic: req.topic ?? 'general',
      max_results: Math.max(1, Math.min(5, req.maxResults ?? 5)),
      include_published_date: true,
      include_answer: false,
      include_raw_content: false,
    };
    if (req.includeDomains?.length) body.include_domains = req.includeDomains;
    if (req.startDate) body.start_date = req.startDate;
    if (req.endDate) body.end_date = req.endDate;
    if (req.filterByPublishedDate) body.filter_by_published_date = true;
    if (req.maxAgeHours !== undefined) body.max_age_hours = req.maxAgeHours;

    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw new SearchError('Search request failed', err);
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 434 is Tavily's flex-capacity refusal. It only happens on requests that
      // ask for live fetching (max_age_hours) while the free tier is loaded.
      if (res.status === 434 && req.maxAgeHours !== undefined) {
        return this.search({ ...req, maxAgeHours: undefined });
      }
      throw new SearchError(`Tavily search failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        published_date?: string;
        score?: number;
      }>;
    };

    return rankSources((json.results ?? [])
      .filter((r) => typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= MIN_RELEVANCE_SCORE && r.url)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: (r.content ?? '').slice(0, 500),
        publishedDate: r.published_date,
        score: r.score,
        official: (req.includeDomains ?? []).some((domain) => {
          try {
            const host = new URL(r.url!).hostname.toLowerCase();
            return host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`);
          } catch { return false; }
        }),
      })), 5);
  }
}
