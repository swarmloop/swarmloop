import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chargeReview, chargeStream } from './spend';
import { parsePriceMarkdown } from './prices';

const TABLE = parsePriceMarkdown(`
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Grok 4.7 | Cursor | $2 | - | $0.5 | $6 | standard |
| Claude Opus 5.5 | Anthropic | $4 | $5 | $0.2 | $20 | base |
`);

const FALLBACK = () => ({ runtime: 'cursor' as const, model: 'grok-4.7' });

describe('spend', () => {
  it('bills cache read at the cache rate and keeps the provider cost when the stream has one', () => {
    const cursor = JSON.stringify({
      type: 'result',
      usage: { inputTokens: 22601, outputTokens: 5787, cacheReadTokens: 324352, cacheWriteTokens: 0 },
    });
    const charged = chargeStream('grok-4.7', cursor, TABLE);
    expect(charged?.tokensIn).toBe(22601 + 324352);
    expect(charged?.tokensOut).toBe(5787);
    expect(charged?.usd).toBeCloseTo(0.2421, 4);

    const resumed = [
      cursor,
      JSON.stringify({
        type: 'result',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ].join('\n');
    const both = chargeStream('grok-4.7', resumed, TABLE);
    expect(both?.tokensIn).toBe(22601 + 324352 + 10);
    expect(both?.usd).toBeCloseTo(0.2421 + (20 + 6) / 1_000_000, 6);

    const reported = JSON.stringify({
      type: 'result',
      total_cost_usd: 1.25,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(chargeStream('grok-4.7', reported, TABLE)?.usd).toBe(1.25);
  });

  it('prices a killed stream from the turns that already ran', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'abcd'.repeat(250) }] } }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'abcd'.repeat(250) }),
      'process killed: time',
    ].join('\n');
    const charged = chargeStream('grok-4.7', raw, TABLE);
    expect(charged?.tokensIn).toBe(250);
    expect(charged?.tokensOut).toBe(250);
    expect(charged?.usd).toBeCloseTo(0.002, 6);
  });

  it('charges the reviewers of one attempt and ignores the files of an older one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-charge-review-'));
    mkdirSync(join(root, 'data'));
    const stream = (inputTokens: number): string =>
      `${JSON.stringify({ type: 'result', usage: { inputTokens, outputTokens: 1 } })}\n`;
    writeFileSync(join(root, 'data', 'K-1-code-review-quality-zzz-output.txt'), stream(900));
    writeFileSync(join(root, 'data', 'K-1-code-review-quality-aaa-output.txt'), stream(100));
    const visits = [{ step: 'code-review-quality', runtime: 'cursor', model: 'grok-4.7' }];
    const charge = await chargeReview(root, 'K-1', visits, () => Promise.resolve(TABLE), 'aaa', FALLBACK);
    expect(charge?.tokensIn).toBe(100);
  });

  it('prices a switched reviewer at the model that ran, by the price table of its runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-charge-switched-'));
    mkdirSync(join(root, 'data'));
    const stream = `${JSON.stringify({ type: 'result', usage: { inputTokens: 1_000_000, outputTokens: 0 } })}\n`;
    writeFileSync(join(root, 'data', 'K-1-code-review-quality-aaa-output.txt'), stream);
    const tables: Record<string, typeof TABLE> = { cursor: TABLE, claude: TABLE };
    const asked: string[] = [];
    const priced = async (visits: { step: string; runtime: string; model: string }[]) =>
      chargeReview(
        root,
        'K-1',
        visits,
        (runtime) => {
          asked.push(runtime);
          return Promise.resolve(tables[runtime] ?? {});
        },
        'aaa',
        FALLBACK,
      );
    const first = await priced([{ step: 'code-review-quality', runtime: 'cursor', model: 'grok-4.7' }]);
    const switched = await priced([
      { step: 'code-review-quality', runtime: 'cursor', model: 'grok-4.7' },
      { step: 'code-review-quality', runtime: 'claude', model: 'claude-opus-5-5' },
    ]);
    expect(first?.usd).toBeCloseTo(2, 6);
    expect(switched?.usd).toBeCloseTo(4, 6);
    expect(asked).toEqual(['cursor', 'claude']);
  });

  it('prices a reviewer that has no visit yet as the fallback agent, and loads each price table once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-charge-died-'));
    mkdirSync(join(root, 'data'));
    const stream = `${JSON.stringify({ type: 'result', usage: { inputTokens: 1_000_000, outputTokens: 0 } })}\n`;
    for (const name of ['quality', 'security']) {
      writeFileSync(join(root, 'data', `K-1-code-review-${name}-aaa-output.txt`), stream);
    }
    const loaded: string[] = [];
    const charge = await chargeReview(
      root,
      'K-1',
      [],
      (runtime) => {
        loaded.push(runtime);
        return Promise.resolve(TABLE);
      },
      'aaa',
      FALLBACK,
    );
    expect(charge?.usd).toBeCloseTo(4, 6);
    expect(loaded).toEqual(['cursor']);
  });
});
