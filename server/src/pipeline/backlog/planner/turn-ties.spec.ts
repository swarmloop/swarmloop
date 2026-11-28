import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';
import type { Tie } from '../../../history/agent-call';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import { RunRepository } from '../../../history/run.repository';
import { storeRun } from '../../../testing/store-run.spec-helpers';
import { backlogHarness } from '../backlog.spec-helpers';
import { TurnTies } from './turn-ties';

type TiesOf = (actions?: BacklogTurnAction[]) => Promise<Tie[]>;
type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withTies(
  body: (h: Harness, backlogId: number, tiesOf: TiesOf, tiesBeforeResult: () => Promise<Tie[]>) => Promise<void>,
): Promise<void> {
  const h = await backlogHarness();
  try {
    const backlogId = (await h.seedBacklog('one')).id as number;
    const chat = h.db.app.get(BacklogChatRepository);
    const ties = new TurnTies(h.backlogs, chat, h.db.app.get(RunRepository));
    const tiesOf: TiesOf = async (actions = []) => (await ties.of(backlogId, 'turn-a'))({ say: '', actions });
    /** The ties a turn row has when it opens: its result is not known yet. */
    const tiesBeforeResult = async () => (await ties.of(backlogId, 'turn-a'))(undefined);
    await body(h, backlogId, tiesOf, tiesBeforeResult);
  } finally {
    await h.db.close();
  }
}

/** A running turn that took one event with these facts. */
async function takeEvent(h: Harness, backlogId: number, facts: Record<string, string>): Promise<void> {
  const chat = h.db.app.get(BacklogChatRepository);
  await chat.saveTurn({
    backlogId,
    turnKey: 'turn-a',
    status: 'running',
    reason: '',
    nextTryAt: null,
    createdAt: h.db.clock.iso(),
  });
  await h.backlogs.recordEvent(backlogId, `event:${Object.values(facts).join(':')}`, 'run-needs-person', facts);
  await chat.takeInto(backlogId, 'turn-a');
}

describe('TurnTies', () => {
  it('ties a turn to the task and run that its event names', () =>
    withTies(async (h, id, tiesOf) => {
      await h.seedTask(id, 'a', { runKey: 'a-1', status: 'running' });
      await h.db.app.get(RunRepository).openWaiting('a-1', '/target');
      await takeEvent(h, id, { slug: 'a', runKey: 'a-1' });
      expect(await tiesOf()).toEqual([{ task: 'a', run: 'a-1', general: false }]);
    }));

  it('ties a turn to the task and the epic of a part that an action names, and names a key once', () =>
    withTies(async (h, id, tiesOf) => {
      const runs = h.db.app.get(RunRepository);
      await h.seedTask(id, 'big', { runKey: 'big-1', status: 'running' });
      const parent = await runs.openWaiting('big-1', '/target');
      const part = await runs.openWaiting('big-1-part', '/target');
      await storeRun(runs, { ...part, parentRunId: parent.id, taskId: 't1' });
      await takeEvent(h, id, { runKey: 'big-1-part' });
      const actions: BacklogTurnAction[] = [
        { action: 'stop', run: 'big-1-part' },
        { action: 'skipTask', run: 'big-1-part', task: 't1' },
      ];
      expect(await tiesOf(actions)).toEqual([{ task: 'big', run: 'big-1-part', epic: 'big-1', general: false }]);
    }));

  it('ties a turn to the task that an action names by its slug, after the ones its events name', () =>
    withTies(async (h, id, tiesOf) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      await h.seedTask(id, 'b', { status: 'waiting' });
      await takeEvent(h, id, { slug: 'b' });
      expect(await tiesOf([{ action: 'deleteTask', task: 'a', revision: 0 }])).toEqual([
        { task: 'b', general: false },
        { task: 'a', general: false },
      ]);
    }));

  it('ties a turn that names none to the first running task in the order of the backlog, marked general', () =>
    withTies(async (h, id, tiesOf) => {
      await h.seedTask(id, 'first', { status: 'waiting' });
      await h.seedTask(id, 'second', { runKey: 'second-1', status: 'running' });
      await h.seedTask(id, 'third', { runKey: 'third-1', status: 'running' });
      await takeEvent(h, id, { repository: 'web' });
      expect(await tiesOf([{ action: 'pause' }])).toEqual([{ task: 'second', run: 'second-1', general: true }]);
    }));

  it('ties a turn that names none to the first waiting task when none runs, and to nothing when none waits', () =>
    withTies(async (h, id, tiesOf) => {
      await h.seedTask(id, 'done', { status: 'merged' });
      await takeEvent(h, id, { repository: 'web' });
      expect(await tiesOf()).toEqual([]);
      await h.seedTask(id, 'next', { status: 'waiting' });
      expect(await tiesOf()).toEqual([{ task: 'next', general: true }]);
    }));

  it('gives the ties its events name, and no action ties, to a turn that has no result yet', () =>
    withTies(async (h, id, tiesOf, tiesBeforeResult) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      await h.seedTask(id, 'b', { status: 'waiting' });
      await takeEvent(h, id, { slug: 'b' });
      expect(await tiesBeforeResult()).toEqual([{ task: 'b', general: false }]);
      expect(await tiesOf([{ action: 'deleteTask', task: 'a', revision: 0 }])).toEqual([
        { task: 'b', general: false },
        { task: 'a', general: false },
      ]);
    }));

  it('gives the general tie to a turn that names none and has no result yet', () =>
    withTies(async (h, id, _tiesOf, tiesBeforeResult) => {
      await h.seedTask(id, 'going', { runKey: 'going-1', status: 'running' });
      await takeEvent(h, id, { repository: 'web' });
      expect(await tiesBeforeResult()).toEqual([{ task: 'going', run: 'going-1', general: true }]);
    }));
});
