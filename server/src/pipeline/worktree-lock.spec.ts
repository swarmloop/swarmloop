import 'reflect-metadata';
import type * as ChildProcess from 'child_process';
import { git } from '../steps/prepare/prepare.step.spec-helpers';
import { RunRetention } from './run-retention';
import { WorkspaceGuard } from './workspace-guard';
import { ageRun, freshRun, makeWorld, type World } from './workspace.spec-helpers';

const gitCalls: string[][] = [];

/** Every git process the server starts is written to `gitCalls` before it runs. */
jest.mock('child_process', () => {
  const real = jest.requireActual<typeof ChildProcess>('child_process');
  const execFile = (command: string, ...rest: unknown[]) => {
    if (command === 'git') gitCalls.push(rest[0] as string[]);
    return (real.execFile as (...args: unknown[]) => unknown)(command, ...rest);
  };
  return { ...real, execFile };
});

/** The `worktree <verb> ... <path>` calls, in order, as `[verb, path]`. The path is the one under `worktrees/`. */
function worktreeCalls(): [string, string][] {
  return gitCalls.flatMap((words) => {
    const verb = words[words.indexOf('worktree') + 1];
    const path = words.find((word) => word.includes('/worktrees/'));
    return words.includes('worktree') && path && ['add', 'lock', 'unlock', 'remove'].includes(verb)
      ? [[verb, path] as [string, string]]
      : [];
  });
}

describe('worktree registrations over the git command log', () => {
  let world: World;
  afterEach(async () => {
    await world.app.close();
  });

  it('locks every added worktree and unlocks every one it removes', async () => {
    world = await makeWorld('PROJ-1');
    await ageRun(world.app, 'PROJ-1', 'done', 10);
    gitCalls.length = 0;

    await world.app.get(RunRetention).apply(3);
    await world.app.get(WorkspaceGuard).ensure(await freshRun(world));
    await world.app.get(RunRetention).apply(0);
    await ageRun(world.app, 'PROJ-1', 'done', 10);
    await world.app.get(RunRetention).apply(3);

    const calls = worktreeCalls();
    expect(calls.map(([verb]) => verb)).toEqual(['unlock', 'remove', 'add', 'lock', 'unlock', 'remove']);
    calls.forEach(([verb, path], index) => {
      if (verb === 'add') expect(calls[index + 1]).toEqual(['lock', path]);
      if (verb === 'remove') expect(calls[index - 1]).toEqual(['unlock', path]);
    });
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).not.toContain(world.worktree);
  });
});
