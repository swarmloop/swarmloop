import type { QueryRunner } from 'typeorm';
import { VisitCostDeltas1797000000001 } from '../history/migrations/1797000000001-visit-cost-deltas';
import { AttemptMeter } from './agent-attempt';
import { NO_USAGE } from './since-recorded';
import { usageFromStream } from './stream';

/** Recorded result lines of one resumed session: each reports the whole session so far, and the part since the last result. */
const SESSION = [
  { total: { usd: 1, input: 10, cacheRead: 90, output: 20 }, own: { usd: 1, input: 10, cacheRead: 90, output: 20 } },
  {
    total: { usd: 2.5, input: 25, cacheRead: 250, output: 50 },
    own: { usd: 1.5, input: 15, cacheRead: 160, output: 30 },
  },
  {
    total: { usd: 4, input: 40, cacheRead: 440, output: 90 },
    own: { usd: 1.5, input: 15, cacheRead: 190, output: 40 },
  },
];

function visitOf(visit: number): (typeof SESSION)[number] {
  const found = SESSION.at(visit);
  if (!found) {
    throw new Error(`no recorded visit ${visit}`);
  }
  return found;
}

type Part = (typeof SESSION)[number]['total'];

/** What step_stats stores for a visit: prompt-side tokens include the cache. */
function stored(part: Part): { usd: number; tokensIn: number; tokensOut: number } {
  return { usd: part.usd, tokensIn: part.input + part.cacheRead, tokensOut: part.output };
}

function resultLine(visit: number, withOwn: boolean): string {
  const { total, own } = visitOf(visit);
  return JSON.stringify({
    type: 'result',
    session_id: 'chat-1',
    total_cost_usd: total.usd,
    usage: { input_tokens: total.input, cache_read_input_tokens: total.cacheRead, output_tokens: total.output },
    ...(withOwn
      ? {
          model_usage_since_last_result: {
            'model-a': {
              inputTokens: own.input,
              outputTokens: own.output,
              cacheReadInputTokens: own.cacheRead,
              cacheCreationInputTokens: 0,
              costUSD: own.usd,
            },
          },
        }
      : {}),
  });
}

/** The chat's recorded usage before a visit: the stored visits that came before it. */
function recordedBefore(visit: number): { usd: number; tokensIn: number; tokensOut: number } {
  return SESSION.slice(0, visit).reduce(
    (sum, row) => ({
      usd: sum.usd + row.own.usd,
      tokensIn: sum.tokensIn + stored(row.own).tokensIn,
      tokensOut: sum.tokensOut + row.own.output,
    }),
    NO_USAGE,
  );
}

function meterFor(visit: number): AttemptMeter {
  return new AttemptMeter({ model: 'test-model', prices: {}, prior: recordedBefore(visit) });
}

function feed(meter: AttemptMeter, line: string): void {
  const piece = meter.ingest(line);
  if (piece) {
    meter.count(piece);
  }
}

describe('the cost of a resumed session', () => {
  it.each([0, 1, 2])('gives visit %i its own cost and tokens from the line that reports them', (visit) => {
    const usage = usageFromStream(resultLine(visit, true));
    const own = visitOf(visit).own;
    expect(usage).toEqual({
      input: own.input,
      output: own.output,
      cacheRead: own.cacheRead,
      cacheWrite: 0,
      reportedUsd: own.usd,
    });
  });

  it.each([0, 1, 2])('keeps the live meter of visit %i within the visit and agrees at its end', (visit) => {
    const own = stored(visitOf(visit).own);
    const meter = meterFor(visit);
    feed(
      meter,
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 1, cache_read_input_tokens: own.tokensIn - 1, output_tokens: 1 } },
      }),
    );
    expect(meter.billed().tokensIn).toBeLessThanOrEqual(own.tokensIn);
    feed(meter, resultLine(visit, true));
    expect(meter.billed()).toEqual({ tokensIn: own.tokensIn, tokensOut: own.tokensOut, usd: own.usd });
  });

  it.each([1, 2])(
    'gives the same deltas for a stream with session totals only, against the recorded result of visit %i',
    (visit) => {
      const own = stored(visitOf(visit).own);
      const meter = meterFor(visit);
      feed(meter, resultLine(visit, false));
      expect(meter.billed()).toEqual({ tokensIn: own.tokensIn, tokensOut: own.tokensOut, usd: own.usd });
      const usage = usageFromStream(resultLine(visit, false), recordedBefore(visit));
      expect(usage).toMatchObject({ output: own.tokensOut, reportedUsd: own.usd });
      expect((usage?.input ?? 0) + (usage?.cacheRead ?? 0)).toBe(own.tokensIn);
    },
  );

  it('rewrites the old rows, stored as session totals, to the same deltas', async () => {
    const rows = SESSION.map((row, index) => ({
      id: index + 1,
      runId: 1,
      chatId: 'chat-1',
      resumed: index === 0 ? 0 : 1,
      ...stored(row.total),
    }));
    const updates: unknown[][] = [];
    const queryRunner = {
      query: async (sql: string, params: unknown[] = []): Promise<unknown> => {
        if (sql.includes('SELECT s.id')) {
          return rows;
        }
        if (sql.includes('UPDATE step_stats')) {
          updates.push(params);
        }
        return undefined;
      },
    } as unknown as QueryRunner;
    await new VisitCostDeltas1797000000001().up(queryRunner);
    expect(updates).toEqual(
      [1, 2].map((visit) => {
        const own = stored(visitOf(visit).own);
        return [own.usd, own.tokensIn, own.tokensOut, visit + 1];
      }),
    );
  });
});
