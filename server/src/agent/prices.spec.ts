import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
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
    expect(table['grok-4.7']).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: null,
      cacheWrite5mPerMillion: null,
      cacheWrite1hPerMillion: null,
    });
    expect(table['grok-4.7-fast']).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 12,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: null,
      cacheWrite5mPerMillion: null,
      cacheWrite1hPerMillion: null,
    });
    expect(priceTokens('grok-4.7', 1_000_000, 500_000, table)).toBe(5);
    expect(priceTokens('grok-4.7', 22_601, 5_787, table, 324_352, 0)).toBeCloseTo(0.2421, 4);
    expect(priceTokens('opus-5.5-extra-high', 1_000_000, 0, table)).toBe(4);
    expect(priceTokens('missing', 10, 10, table)).toBeNull();
  });

  it('uses a cache younger than a day and refetches an older one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prices-'));
    const fetches: number[] = [];
    let failNext = false;
    const fetchPage = async () => {
      fetches.push(fetches.length);
      const response = failNext ? new Response('no', { status: 500 }) : new Response(PAGE, { status: 200 });
      failNext = false;
      return response;
    };
    const now = Date.parse('2026-10-16T12:00:00.000Z');
    expect(await loadPriceTable(root, 'cursor', now, fetchPage)).toEqual(table);
    expect(fetches).toHaveLength(1);
    expect(await loadPriceTable(root, 'cursor', now + 60_000, fetchPage)).toEqual(table);
    expect(fetches).toHaveLength(1);
    failNext = true;
    expect(await loadPriceTable(root, 'cursor', now + 25 * 60 * 60 * 1000, fetchPage)).toEqual(table);
    expect(fetches).toHaveLength(2);
    const stored = JSON.parse(await readFile(join(root, 'data', 'price-cache-cursor.json'), 'utf8')) as {
      fetchedAt: string;
    };
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
      cacheWrite5mPerMillion: null,
      cacheWrite1hPerMillion: null,
    });
  });

  it('reads the cache columns of the Claude page by name', () => {
    const claude = parsePriceMarkdown(`
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
`);
    expect(claude['claude-opus-5.5']).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: null,
      cacheWrite5mPerMillion: 5,
      cacheWrite1hPerMillion: 8,
    });
  });

  it('fills the rates the page lacks from the runtime when it loads the table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prices-claude-'));
    const page = `
| Model | Base Input Tokens | Output Tokens |
| --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $20 / MTok |
`;
    const loaded = await loadPriceTable(
      root,
      'claude',
      Date.parse('2026-11-27T00:00:00.000Z'),
      async () => new Response(page, { status: 200 }),
    );
    expect(loaded['claude-opus-5.5']).toMatchObject({ cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 });
    expect(priceTokens('claude-opus-5.5', 0, 0, loaded, 1_000_000, 0)).toBe(0.2);
  });

  it('fetches a cached table again when it lacks the cache length columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prices-old-'));
    const now = Date.parse('2026-11-27T00:00:00.000Z');
    await mkdir(join(root, 'data'), { recursive: true });
    const old = {
      'claude-opus-5.5': {
        inputPerMillion: 4,
        outputPerMillion: 20,
        cacheReadPerMillion: null,
        cacheWritePerMillion: 5,
      },
    };
    await writeFile(
      join(root, 'data', 'price-cache-claude.json'),
      JSON.stringify({ fetchedAt: new Date(now - 60_000).toISOString(), prices: old }),
    );
    const page = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
`;
    let fetched = 0;
    const loaded = await loadPriceTable(root, 'claude', now, async () => {
      fetched += 1;
      return new Response(page, { status: 200 });
    });
    expect(fetched).toBe(1);
    expect(loaded['claude-opus-5.5']).toMatchObject({ cacheWrite1hPerMillion: 8, cacheReadPerMillion: 0.2 });
  });
});
