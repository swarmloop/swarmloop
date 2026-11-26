import type { AgentExchangeEntity } from '../../history/entities';
import { exchangesOf } from './visit-parts';

let nextId = 0;

/** A row of the call log as the run page reads it: linked to visit 1, one call of a launch. */
function row(fields: Partial<AgentExchangeEntity>): AgentExchangeEntity {
  nextId += 1;
  return {
    id: nextId,
    stepStatId: 1,
    kind: 'call',
    model: 'm',
    durationMs: 10,
    requestText: `request ${nextId}`,
    responseText: `response ${nextId}`,
    startReason: null,
    previousId: null,
    ...fields,
  } as AgentExchangeEntity;
}

describe('exchangesOf', () => {
  it('shows one exchange per launch: its first request and the last follow-up response', () => {
    const first = row({ requestText: 'ask', responseText: 'refused' });
    const followUp = row({ startReason: 'follow-up', previousId: first.id, responseText: 'fixed' });
    const last = row({ startReason: 'follow-up', previousId: followUp.id, responseText: 'final', durationMs: 5 });
    const next = row({ requestText: 'next ask', responseText: 'next answer' });

    expect(exchangesOf([first, followUp, last, next], 1)).toEqual([
      { model: 'm', durationMs: 25, request: 'ask', response: 'final' },
      { model: 'm', durationMs: 10, request: 'next ask', response: 'next answer' },
    ]);
  });

  it('leaves out helper, ping and ping-stop rows', () => {
    const call = row({ requestText: 'ask', responseText: 'answer' });
    const rows = [
      call,
      row({ kind: 'helper' }),
      row({ kind: 'ping', stepStatId: 1 }),
      row({ kind: 'ping-stop', stepStatId: 1 }),
    ];

    expect(exchangesOf(rows, 1).map((exchange) => exchange.request)).toEqual(['ask']);
  });

  it('leaves out a row with no request text, the cost row the log migration made for an old visit', () => {
    const backfilled = row({ requestText: '', responseText: '' });

    expect(exchangesOf([backfilled], 1)).toEqual([]);
  });

  it('shows each launch of a failover on its own, and only the rows of the visit', () => {
    const limited = row({ requestText: 'ask', responseText: '' });
    const moved = row({ startReason: 'failover', previousId: limited.id, requestText: 'ask', responseText: 'answer' });
    const elsewhere = row({ stepStatId: 2 });

    expect(exchangesOf([limited, moved, elsewhere], 1).map((exchange) => exchange.response)).toEqual(['', 'answer']);
  });
});
