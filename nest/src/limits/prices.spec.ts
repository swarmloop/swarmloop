import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { priceTokens } from './limits';
import { loadPriceTable, parsePriceMarkdown } from './prices';

const PAGE = `
| Plan | Price |
| --- | --- |
| Plus | $8/mo |

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Grok 4.7 | Cursor | $2 | - | $0.5 | $6 | standard |
| Grok 4.7 (Fast) | Cursor | $4 | - | $1 | $12 | fast |
| Grok 4.7 500k | Cursor | $4 | - | $1 | $12 | long |
| Claude Opus 5.5 | Anthropic | $4 | $5 | $0.2 | $20 | base |
`;

describe('prices', () => {
  const table = parsePriceMarkdown(PAGE);

  it('prices the base model and ignores a longer variant', () => {
    expect(table['grok-4.7']).toEqual({ inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5, cacheWritePerMillion: null });
    expect(table['grok-4.7-fast']).toEqual({ inputPerMillion: 4, outputPerMillion: 12, cacheReadPerMillion: 1, cacheWritePerMillion: null });
    expect(priceTokens('grok-4.7', 1_000_000, 500_000, table)).toBe(5);
    expect(priceTokens('grok-4.7', 22_601, 5_787, table, 324_352, 0)).toBeCloseTo(0.2421, 4);
    expect(priceTokens('opus-5.5-extra-high', 1_000_000, 0, table)).toBe(4);
    expect(priceTokens('missing', 10, 10, table)).toBeNull();
  });

  it('uses a cache younger than a day and refetches an older one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prices-'));
    const fetchPage = jest.fn(async () => new Response(PAGE, { status: 200 }));
    const now = Date.parse('2026-10-16T12:00:00.000Z');
    expect(await loadPriceTable(root, 'cursor', now, fetchPage)).toEqual(table);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(await loadPriceTable(root, 'cursor', now + 60_000, fetchPage)).toEqual(table);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    fetchPage.mockResolvedValueOnce(new Response('no', { status: 500 }));
    expect(await loadPriceTable(root, 'cursor', now + 25 * 60 * 60 * 1000, fetchPage)).toEqual(table);
    const stored = JSON.parse(await readFile(join(root, 'data', 'price-cache-cursor.json'), 'utf8')) as { fetchedAt: string };
    expect(stored.fetchedAt).toBe('2026-10-16T12:00:00.000Z');
  });

  it('prices Claude from the base row, not the fast or long-context row', () => {
    const claude = parsePriceMarkdown(`
| Model | Base input tokens | Output tokens |
| --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $20 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $2.50 / MTok |

| Model | Input | Output |
| --- | --- | --- |
| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |
`);
    expect(priceTokens('claude-opus-5-5', 1_000_000, 0, claude)).toBe(4);
    expect(priceTokens('opus-5.5-extra-high', 0, 1_000_000, claude)).toBe(20);
    expect(claude['claude-haiku-5.5']).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    });
  });
});