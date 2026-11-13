export interface SearchRequest {
  query: string;
  /** YYYY-MM-DD, inclusive lower bound on publish date. */
  startDate?: string;
  /** YYYY-MM-DD, inclusive upper bound on publish date. */
  endDate?: string;
  topic?: 'general' | 'news';
  maxResults?: number;
  /** Restrict results to these domains. */
  includeDomains?: string[];
  /**
   * Max age (hours) of Tavily's cached copy of each result. 1-720, 0 = always
   * fetch live. Use this instead of a date window to read a page that is
   * edited in place (a pricing page): a date window filters on *publish* date,
   * so it drops such pages no matter how fresh their content is.
   */
  maxAgeHours?: number;
  /** Drop results with no detectable publish date (only meaningful with a date window). */
  filterByPublishedDate?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  score?: number;
  official?: boolean;
}

/** The single interface every search backend implements. */
export interface SearchProvider {
  readonly name: string;
  search(req: SearchRequest): Promise<SearchResult[]>;
}
export class SearchError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SearchError';
  }
}
