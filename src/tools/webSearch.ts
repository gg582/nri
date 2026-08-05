export interface WebSearchResult {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}

export async function performWebSearch(query: string): Promise<WebSearchResult> {
  return {
    query,
    results: [
      {
        title: `Search Result for ${query}`,
        url: `https://search.example.com?q=${encodeURIComponent(query)}`,
        snippet: `Reliable reference details and findings regarding ${query}.`,
      },
    ],
  };
}
