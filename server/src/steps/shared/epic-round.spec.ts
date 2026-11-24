import 'reflect-metadata';
import type { Subtask } from '../../contract/subtask';
import { CommandRepository } from '../../history/command.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { mainMovedNote } from '../implement/split-rebase';
import type { RunRebase } from '../run-rebase';
import { EpicRound } from './epic-round';
import type { RebaseEvent, SubtaskOps } from './subtask-ops';

const TIP = 'billing@abc123';

const task = (id: string, status: Subtask['status']): Subtask => ({
  id,
  title: `Task ${id}`,
  description: '',
  depends: [],
  files: [],
  proof: id,
  status,
});

/** The tasks a fake SubtaskOps moved, with the event each was sent. */
interface Moved {
  id: string;
  event: RebaseEvent | undefined;
}

function fakes(own: { committed: string | null; conflict: string | null }, withoutRun: string[] = []) {
  const moved: Moved[] = [];
  const ops = {
    commitOwnEdits: () => Promise.resolve(own),
    find: (_parent: RunEntity, id: string) =>
      Promise.resolve(withoutRun.includes(id) ? null : ({ key: `child-${id}` } as RunEntity)),
    rebase: (child: RunEntity, event?: RebaseEvent) => {
      moved.push({ id: child.key.replace('child-', ''), event });
      return Promise.resolve(true);
    },
  } as unknown as SubtaskOps;
  const rebase = { tipOf: () => Promise.resolve(TIP) } as unknown as RunRebase;
  return { moved, ops, rebase };
}

describe('EpicRound', () => {
  let app: TestApp;
  let parent: RunEntity;
  let commands: CommandRepository;

  beforeEach(async () => {
    app = await createTestApp();
    parent = await app.app.get(RunRepository).begin('PROJ-500', 'code-review');
    commands = app.app.get(CommandRepository);
  });
  afterEach(() => app.close());

  async function send(payload: Record<string, unknown>, idempotencyKey: string): Promise<void> {
    app.clock.advance(1000);
    await commands.accept({ type: 'rebase', key: parent.key, payload, idempotencyKey, admit: () => undefined });
  }

  const tasks = [task('a', 'merged'), task('b', 'running'), task('c', 'blocked'), task('d', 'waiting')];

  it('moves each open task onto the tip with the note of the main the newest rebase command names', async () => {
    await send({ main: 'old-head' }, 'k1');
    await send({ main: 'new-head' }, 'k2');
    const { moved, ops, rebase } = fakes({ committed: null, conflict: null }, ['d']);

    const ended = await new EpicRound(ops, rebase, commands).finish(parent, tasks);

    expect(ended).toEqual({ conflict: null });
    expect(moved).toEqual([
      { id: 'b', event: { tip: TIP, note: mainMovedNote('new-head') } },
      { id: 'c', event: { tip: TIP, note: mainMovedNote('new-head') } },
    ]);
  });

  it("sends a person's Rebase the plain rebase", async () => {
    await send({}, 'k1');
    const { moved, ops, rebase } = fakes({ committed: null, conflict: null });

    await new EpicRound(ops, rebase, commands).finish(parent, tasks);

    expect(moved).toEqual([
      { id: 'b', event: undefined },
      { id: 'c', event: undefined },
      { id: 'd', event: undefined },
    ]);
  });

  it('moves no task and returns the conflict of the epic own edits', async () => {
    await send({ main: 'new-head' }, 'k1');
    const { moved, ops, rebase } = fakes({ committed: null, conflict: 'src/a.ts conflicts' });

    const ended = await new EpicRound(ops, rebase, commands).finish(parent, tasks);

    expect(ended).toEqual({ conflict: 'src/a.ts conflicts' });
    expect(moved).toEqual([]);
  });
});
