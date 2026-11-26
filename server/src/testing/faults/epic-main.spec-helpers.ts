import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ERROR_CODES } from '../../contract/error-codes';
import { CommandRepository } from '../../history/command.repository';
import { CommandService } from '../../pipeline/command.service';
import { Reconciler } from '../../pipeline/reconciler';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import type { createFlowHarness } from '../flow-harness';
import { git } from '../runs.spec-helpers';
import { storeRun } from '../store-run.spec-helpers';
import type { epicMerges } from './epic-merge.spec-helpers';

type Flow = Awaited<ReturnType<typeof createFlowHarness>>;

const OWN = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];

/** A commit on main, pushed from a clone of its own; the head. */
export function landOnMain(flow: Flow): string {
  const other = mkdtempSync(join(tmpdir(), 'swarmloop-main-'));
  try {
    git(other, ['clone', '--branch', 'main', join(flow.app.root, 'demo.git'), 'clone']);
    const work = join(other, 'clone');
    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(join(work, 'src/fix.ts'), 'export const fix = 1;\n');
    git(work, ['add', 'src/fix.ts']);
    git(work, [...OWN, 'commit', '-m', 'fix: main']);
    git(work, ['push', 'origin', 'main']);
    return git(work, ['rev-parse', 'HEAD']);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}

/** The epic with a part `a` that is done and a part `b` that waits on a sibling, both with worktrees and a merge request. */
export async function epicWithTwoParts(flow: Flow, epic: ReturnType<typeof epicMerges>, key: string): Promise<void> {
  const runs = flow.app.app.get(RunRepository);
  await epic.seed(['a', 'b']);
  await epic.deliver('a');
  await epic.deliver('b');
  for (const id of ['a', 'b']) {
    const part = (await runs.findRun(`${key}-${id}`))!;
    part.codeHost = 'gitlab';
    await storeRun(runs, part);
  }
  const waiting = (await runs.findRun(`${key}-b`))!;
  writeRunState(waiting, {
    status: 'waiting',
    currentStep: 'research',
    reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waits for a sibling' },
  });
  await storeRun(runs, waiting);
  const parent = (await runs.findRun(key))!;
  writeRunState(parent, {
    status: 'waiting',
    currentStep: 'implement',
    reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'subtasks run' },
  });
  await storeRun(runs, parent);
}

/** A command of a process that died while it ran: stored and executing. */
export async function takenByDeadProcess(
  flow: Flow,
  key: string,
  type: 'rebase',
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  const commands = flow.app.app.get(CommandRepository);
  const { command } = await commands.accept({ type, key, payload, idempotencyKey, admit: () => undefined });
  await commands.start(command.id);
}

/**
 * A restart whose start-up work runs once the new process is wired, in the order of the real start: the lost commands,
 * then the parents of subtasks. The harness wires the fake code host after the app has started, and a command taken
 * while the app starts would reach the real host.
 */
export async function restartThenRecover(flow: Flow): Promise<void> {
  const recover = jest.spyOn(CommandService.prototype, 'recover').mockResolvedValueOnce(undefined);
  const parents = jest.spyOn(Reconciler.prototype, 'resumeSubtaskParents').mockResolvedValueOnce(undefined);
  await flow.restart();
  recover.mockRestore();
  parents.mockRestore();
  const reconciler = flow.app.app.get(Reconciler);
  await reconciler.reconcileCommands();
  await flow.app.app.get(CommandService).idle();
  await reconciler.resumeSubtaskParents();
}
