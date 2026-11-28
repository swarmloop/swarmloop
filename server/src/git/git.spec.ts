import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { runInStepScope } from '../core/step-event-scope';
import type { StepEventDraft } from '../contract/step-events';
import { authorArgs, git, gitDetail, gitRaw, withSafeDirectory } from './git';

describe('git errors', () => {
  it('preserves the exit code when a reference is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-git-missing-'));
    await git(['init', '-b', 'main', root]);

    await expect(git(['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/missing'])).rejects.toMatchObject({
      code: 1,
      message: expect.stringMatching(/^Command failed:/),
    });
  });

  it('preserves the exit code and patch for an untracked file diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-git-diff-'));
    writeFileSync(join(root, 'New.php'), '<?php\n');

    await expect(gitRaw(['-C', root, 'diff', '--no-index', '--', '/dev/null', 'New.php'])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('+<?php'),
    });
  });
});

describe('git command spans', () => {
  async function recorded(run: () => Promise<unknown>): Promise<StepEventDraft[]> {
    const events: StepEventDraft[] = [];
    const scope = {
      runId: 1,
      attemptId: 'a',
      step: 'commit' as const,
      root: tmpdir(),
      clock: new FakeClock(),
      sink: (event: StepEventDraft) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    await runInStepScope(scope, run);
    return events.filter((event) => event.kind === 'command.finished');
  }

  it('records authorArgs in a repo without user.email as an answer, not a failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-git-author-'));
    await git(['init', '-b', 'main', root]);

    const ended = await recorded(() => authorArgs(root));

    expect(ended).toMatchObject([{ exitCode: 1, answer: true }]);
  });

  it('keeps the whole output of a long call that is not a read, with no omitted lines', async () => {
    const ended = await recorded(() => git(['-c', 'alias.many=!seq 1 100', 'many']));

    const output = (ended[0] as { output: string }).output;
    expect(output.split('\n')).toHaveLength(100);
    expect(ended[0]).not.toHaveProperty('omittedLines');
  });

  it('records a git call that really fails without an answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-git-fails-'));

    const ended = await recorded(() => git(['-C', root, 'log']).catch(() => ''));

    expect(ended).toHaveLength(1);
    expect(ended[0]).not.toHaveProperty('answer');
    expect(ended[0]).not.toMatchObject({ exitCode: 0 });
  });
});

describe('git time limit', () => {
  it('fails a call that outlives its limit with the command and the limit named', async () => {
    // `hash-object --stdin` waits for input that never comes.
    await expect(git(['hash-object', '--stdin'], undefined, { timeoutMs: 300 })).rejects.toThrow(
      'git hash-object timed out after 0.3 s',
    );
  });
});

describe('gitDetail of a timeout', () => {
  it('names the timeout even when git printed progress lines first', () => {
    const error = { stderr: 'remote: Counting objects\n', message: 'git fetch timed out after 180 s' };

    expect(gitDetail(error)).toBe('git fetch timed out after 180 s');
  });
});

describe('withSafeDirectory', () => {
  let root: string;
  let checkouts: string;
  let worktrees: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-git-'));
    checkouts = join(root, 'checkouts');
    worktrees = join(root, 'worktrees');
    mkdirSync(join(checkouts, 'billing-api'), { recursive: true });
    mkdirSync(join(worktrees, 'PROJ-1', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'checkouts-evil', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
  });

  it('trusts the checkout this command opens', () => {
    const directory = join(checkouts, 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'rev-parse'], [checkouts, worktrees])).toEqual([
      '-c',
      `safe.directory=${realpathSync(directory)}`,
      '-C',
      directory,
      'rev-parse',
    ]);
  });

  it('trusts a worktree under the worktree mount', () => {
    const directory = join(worktrees, 'PROJ-1', 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts, worktrees])[1]).toBe(
      `safe.directory=${realpathSync(directory)}`,
    );
  });

  it('leaves a command alone when it has no checkout', () => {
    expect(withSafeDirectory(['status'], [checkouts])).toEqual(['status']);
  });

  it('does not trust a directory outside the mounts', () => {
    const directory = join(root, 'outside');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts, worktrees])).toEqual(['-C', directory, 'status']);
  });

  it('does not trust a path that escapes the mount', () => {
    const directory = join(checkouts, '..', 'outside');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });

  it('does not trust a directory whose name only starts with the mount', () => {
    const directory = join(root, 'checkouts-evil', 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });

  it('trusts the checkout the caller names, for a command that has no -C', () => {
    const directory = join(checkouts, 'billing-api');
    const args = ['clone', '--', directory, join(root, 'snapshot')];
    expect(withSafeDirectory(args, [checkouts, worktrees], directory)).toEqual([
      '-c',
      `safe.directory=${realpathSync(directory)}`,
      ...args,
    ]);
  });

  it('does not trust a named checkout outside the mounts', () => {
    const args = ['clone', '--', 'x', 'y'];
    expect(withSafeDirectory(args, [checkouts], join(root, 'outside'))).toEqual(args);
    expect(withSafeDirectory(args, [checkouts], join(root, 'checkouts-evil', 'billing-api'))).toEqual(args);
  });

  it('does not trust a missing directory', () => {
    const directory = join(checkouts, 'missing');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });
});
