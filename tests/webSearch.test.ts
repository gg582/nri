import { webSearch } from '../src/tools/webSearch';

describe('webSearch', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should parse duckduckgo search results successfully', async () => {
    const mockHtml = `
      <div class="result__body">
        <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com">Example Title</a>
        <div class="result__snippet">This is an example snippet.</div>
      </div>
    `;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    } as any);

    const result = await webSearch('example query', 5);
    expect(result.query).toBe('example query');
    expect(result.results.length).toBe(1);
    expect(result.results[0]).toEqual({
      title: 'Example Title',
      snippet: 'This is an example snippet.',
      url: 'https://example.com',
    });
  });

  it('should handle direct URLs without uddg parameter', async () => {
    const mockHtml = `
      <div class="result__body">
        <a class="result__a" href="https://example.com/direct">Direct Title</a>
        <td class="result__snippet">Direct snippet</td>
      </div>
    `;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    } as any);

    const result = await webSearch('direct test');
    expect(result.results[0].url).toBe('https://example.com/direct');
    expect(result.results[0].snippet).toBe('Direct snippet');
  });

  it('should handle failed HTTP status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const result = await webSearch('fail query');
    expect(result.error).toBe('Search request failed with status 500');
    expect(result.results).toEqual([]);
  });

  it('should handle fetch exception', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const result = await webSearch('network error query');
    expect(result.error).toBe('Network error');
    expect(result.results).toEqual([]);
  });

  it('should respect the limit parameter', async () => {
    const mockHtml = `
      <div class="result__body">
        <a class="result__a" href="https://ex1.com">Title 1</a>
        <div class="result__snippet">Snippet 1</div>
      </div>
      <div class="result__body">
        <a class="result__a" href="https://ex2.com">Title 2</a>
        <div class="result__snippet">Snippet 2</div>
      </div>
    `;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    } as any);

    const result = await webSearch('limit test', 1);
    expect(result.results.length).toBe(1);
    expect(result.results[0].title).toBe('Title 1');
  });
});
