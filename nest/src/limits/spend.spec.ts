import { chargeStream } from './spend';
import { parsePriceMarkdown } from './prices';

const TABLE = parsePriceMarkdown(`
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Grok 4.7 | Cursor | $2 | - | $0.5 | $6 | standard |
| Claude Opus 5.5 | Anthropic | $4 | $5 | $0.2 | $20 | base |
`);

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
});
