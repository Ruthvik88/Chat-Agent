import { TavilySearchProvider } from './tavily';
import type { SearchProvider } from './types';

/** Swap this single line to switch search backends. */
export function createSearchProvider(): SearchProvider {
  return new TavilySearchProvider();
}
