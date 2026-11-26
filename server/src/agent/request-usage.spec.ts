import { foldRequestUsage, RequestLedger } from './request-usage';
import { readStreamLine } from './stream';

const prices = {
  opus: { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1, cacheWritePerMillion: 5 },
  sonnet: { inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 1 },
};

function assistant(
  id: string,
  model: string,
  usage: { input?: number; read?: number; write?: number; output?: number },
  parent: string | null = null,
): string {
  return JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id,
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: usage.write ?? 0,
        output_tokens: usage.output ?? 0,
      },
    },
  });
}

function ledgerOf(...lines: string[]): RequestLedger {
  const ledger = new RequestLedger(prices, 'opus');
  for (const line of lines) {
    const request = readStreamLine(line)?.request;
    if (request) {
      ledger.add(request);
    }
  }
  return ledger;
}

describe('RequestLedger', () => {
  it('counts an assistant message once by its id and keeps its latest usage', () => {
    const ledger = ledgerOf(
      assistant('m1', 'opus', { input: 100, output: 1 }),
      assistant('m1', 'opus', { input: 100, output: 50 }),
    );
    expect(ledger.size).toBe(1);
    expect(ledger.totals()).toEqual({ tokensIn: 100, tokensOut: 50, usd: (100 * 10 + 50 * 20) / 1e6 });
  });

  it('reports a request again only when its id is new or its usage changed', () => {
    const ledger = new RequestLedger(prices, 'opus');
    const raw = readStreamLine(assistant('m1', 'opus', { output: 5 }))?.request;
    if (!raw) {
      throw new Error('expected a request');
    }
    expect(ledger.add(raw)).not.toBeNull();
    expect(ledger.add(raw)).toBeNull();
    expect(ledger.add({ ...raw, output: 6 })?.output).toBe(6);
  });

  it('prices each request at its own model, and an unknown model as the launch model', () => {
    const ledger = ledgerOf(
      assistant('m1', 'opus', { input: 1000, read: 2000, write: 3000, output: 100 }),
      assistant('m2', 'sonnet', { input: 1000, output: 100 }),
      assistant('m3', 'mystery', { input: 1000 }),
    );
    const byModel = Object.fromEntries(ledger.byModel().map((entry) => [entry.model, entry.usd]));
    expect(byModel.opus).toBeCloseTo((1000 * 10 + 2000 * 1 + 3000 * 5 + 100 * 20) / 1e6);
    expect(byModel.sonnet).toBeCloseTo((1000 * 2 + 100 * 4) / 1e6);
    expect(byModel.mystery).toBeCloseTo((1000 * 10) / 1e6);
    expect(Object.keys(ledger.priceRows())).toEqual(['opus', 'sonnet', 'mystery']);
  });

  it('keeps a helper apart by parent_tool_use_id and out of the main agent', () => {
    const ledger = ledgerOf(
      assistant('m1', 'opus', { input: 100 }),
      assistant('h1', 'sonnet', { input: 1000 }, 'tool-a'),
      assistant('h2', 'sonnet', { input: 500 }, 'tool-a'),
      assistant('h3', 'sonnet', { input: 200 }, 'tool-b'),
    );
    expect(ledger.byModel().map((entry) => entry.model)).toEqual(['opus']);
    expect(ledger.helpers().map((helper) => [helper.parentToolUseId, helper.usage.input])).toEqual([
      ['tool-a', 1500],
      ['tool-b', 200],
    ]);
    expect(ledger.totals().usd).toBeCloseTo((100 * 10 + 1700 * 2) / 1e6);
  });

  it('reads a Codex turn as one request of the launch model, without its cached tokens in the input', () => {
    const turn = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 },
    });
    const ledger = ledgerOf(turn, turn);
    expect(ledger.size).toBe(2);
    expect(ledger.byModel()).toEqual([
      { model: 'opus', input: 400, cacheRead: 1600, cacheWrite: 0, output: 20, usd: expect.any(Number) },
    ]);
  });

  it('keeps its requests when the stream is cut before the result line', () => {
    const ledger = ledgerOf(assistant('m1', 'opus', { input: 10 }), '{"type":"assistant","message":{"id":"m2","usa');
    expect(ledger.size).toBe(1);
  });

  it('ignores a line with no request usage', () => {
    expect(
      ledgerOf('{"type":"result","usage":{"input_tokens":5}}', '{"type":"assistant","message":{"id":"m"}}').size,
    ).toBe(0);
  });
});

describe('foldRequestUsage', () => {
  it('adds the same model and the same helper over two launches', () => {
    const first = ledgerOf(assistant('a', 'opus', { input: 10 }), assistant('h', 'sonnet', { input: 5 }, 't')).usage();
    const second = ledgerOf(
      assistant('b', 'opus', { input: 20 }),
      assistant('h2', 'sonnet', { input: 7 }, 't'),
    ).usage();
    const folded = foldRequestUsage(first, second);
    expect(folded.byModel.map((entry) => [entry.model, entry.input])).toEqual([['opus', 30]]);
    expect(folded.helpers.map((helper) => [helper.parentToolUseId, helper.usage.input, helper.usd])).toEqual([
      ['t', 12, (12 * 2) / 1e6],
    ]);
    expect(Object.keys(folded.prices).sort()).toEqual(['opus', 'sonnet']);
  });
});
