import type { PlanChatEntry } from '../../contract/plan-chat';
import type { RunEntity } from '../../history/entities';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { ModelStepContext } from '../model-step-context';
import { asksForStarter } from './starter-asks';
import { StarterExchange } from './starter-exchange';
import { runWaitNote } from '../../contract/subtask';

const CLOCK = { now: () => 0, iso: () => '2026-01-01T00:00:00.000Z' };

/** A subtask's step context with its documents and plan chat held in memory. */
function world(parentRunId: number | null = 4) {
  const run = { key: 'PROJ-1-t1', taskId: 't1', parentRunId } as RunEntity;
  const written: Record<string, string> = {};
  const entries: PlanChatEntry[] = [];
  const chat = {
    appendEntry: (_key: string, entry: PlanChatEntry) => {
      if (!entries.some((known) => known.key === entry.key)) entries.push(entry);
      return Promise.resolve();
    },
  } as unknown as PlanChatStore;
  const ctx = {
    opened: { run, startedAt: 'T0', attemptId: 'a1' },
    reread: (artifact: { kind: string }) => Promise.resolve(written[artifact.kind] ?? null),
    write: (artifact: { kind: string }, value: string) => {
      written[artifact.kind] = value;
      return Promise.resolve();
    },
  } as unknown as ModelStepContext;
  return { run, written, entries, ctx, exchange: new StarterExchange(chat, CLOCK) };
}

const visit = (over: Record<string, unknown> = {}) =>
  ({ step: 'research', route: 'document', answered: false, mayAsk: true, outputs: [], ...over }) as never;

describe('StarterExchange', () => {
  it('waits for the siblings a subtask needs, as needsWait does', async () => {
    const { ctx, exchange } = world();
    const { wait } = await exchange.act(ctx, { needs: [{ id: 't0', what: 'the policy' }] }, visit());
    expect(wait?.route).toMatchObject({ to: 'wait', reason: 'waiting for t0: the policy' });
  });

  it('writes a question of research or plan as the step questions and waits', async () => {
    const { ctx, exchange } = world();
    const { wait } = await exchange.act(ctx, { question: 'Which column?' }, visit());
    expect(wait?.route).toEqual({ to: 'wait', reason: 'questions are open' });
    expect(wait?.outputs).toMatchObject([{ value: '- Which column?\n' }]);
  });

  it('sends a question of implement to the own planner and waits holding no container', async () => {
    const { ctx, exchange, entries } = world();
    const { wait } = await exchange.act(
      ctx,
      { question: 'Which column?' },
      visit({ step: 'implement', route: 'chat' }),
    );
    expect(wait?.route).toMatchObject({ to: 'wait', code: 'ASKS_PLANNER' });
    if (wait?.route.to !== 'wait') throw new Error('Expected a planner wait');
    expect(
      runWaitNote(
        { id: 't1' },
        { state: 'waiting', stateReason: { code: 'ASKS_PLANNER', message: wait.route.reason } },
      ),
    ).toBe('t1 asks its own planner: Which column?');
    expect(entries).toMatchObject([{ kind: 'question', from: 'implement', text: 'Which column?', state: 'pending' }]);
    expect(wait?.outputs).toEqual([]);
  });

  it('turns a second question of the visit into an assumption', async () => {
    const { ctx, exchange, entries } = world();
    const outcome = await exchange.act(
      ctx,
      { question: 'Which column?' },
      visit({ step: 'implement', route: 'chat', answered: true }),
    );
    expect(outcome).toEqual({ wait: null, assumed: ['Which column?'] });
    expect(entries).toEqual([]);
  });

  it('writes decisions and parts left out to the report, once for an attempt', async () => {
    const { ctx, exchange, written } = world();
    const fields = {
      decisions: [{ item: 'own', text: 'three tries' }],
      outOfScope: [{ what: 'the cache', needed: false }],
    };
    await exchange.act(ctx, fields, visit({ answered: true }));
    await exchange.act(ctx, fields, visit({ answered: true }));
    expect(JSON.parse(written.starter_report)).toEqual([{ key: 'research-a1', step: 'research', ...fields }]);
  });

  it('asks a hand-back like a question: in the questions at research, as a pending entry at implement', async () => {
    const research = world();
    const fields = { outOfScope: [{ what: 'the cache', needed: true }] };
    const asked = await research.exchange.act(research.ctx, fields, visit());
    expect(asked.wait?.outputs).toMatchObject([
      { value: '- hands back (the task cannot go on without it): the cache\n' },
    ]);

    const implement = world();
    const wait = (await implement.exchange.act(implement.ctx, fields, visit({ step: 'implement', route: 'chat' })))
      .wait;
    expect(wait?.route).toMatchObject({
      to: 'wait',
      reason: 'implement asks the planner of the parent: hands back (the task cannot go on without it): the cache',
    });
    if (wait?.route.to !== 'wait') throw new Error('Expected a planner wait');
    expect(
      runWaitNote(
        { id: 't1' },
        { state: 'waiting', stateReason: { code: 'ASKS_PLANNER', message: wait.route.reason } },
      ),
    ).toBe('t1 asks the planner of the parent: hands back (the task cannot go on without it): the cache');
    expect(asksForStarter({ entries: implement.entries }).map((entry) => entry.text)).toEqual([
      'hands back (the task cannot go on without it): the cache',
    ]);
  });

  it('hands up decisions and texts without a wait, once for an attempt', async () => {
    const { ctx, exchange, written, entries } = world();
    const fields = {
      decisions: [{ item: 'own', text: 'three tries' }],
      question: 'Which column?',
      outOfScope: [{ what: 'the cache', needed: false }],
    };
    await exchange.handUp(ctx, fields, 'implement', ['Who owns the log?']);
    await exchange.handUp(ctx, fields, 'implement', ['Who owns the log?']);
    const { question: _question, ...reported } = fields;
    expect(JSON.parse(written.starter_report)).toEqual([{ key: 'implement-a1', step: 'implement', ...reported }]);
    expect(asksForStarter({ entries }).map((entry) => entry.text)).toEqual([
      'Which column?',
      'Who owns the log?',
      'hands back: the cache',
    ]);
  });

  describe('check', () => {
    const contract = '- retry (owner t0): three tries\n- own (owner t1): ours\n';

    it('refuses a decision about an item another task owns, and tells to send it as question', () => {
      const { run, exchange } = world();
      const decisions = [{ item: 'retry', text: 'five' }];
      expect(exchange.check(run, { decisions }, contract)).toEqual([
        'decisions: retry is owned by t0; send it as question',
      ]);
      expect(exchange.check(run, { decisions: [{ item: 'own', text: 'x' }] }, contract)).toEqual([]);
    });

    it('checks nothing of a run that is not a subtask', () => {
      const { run, exchange } = world(null);
      expect(exchange.check(run, { decisions: [{ item: 'retry', text: 'five' }] }, contract)).toEqual([]);
    });
  });
});
