import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../../config/env';
import { testEnv } from '../../../config/env.spec-helpers';
import { FakeClock } from '../../../core/fake-clock.spec-helpers';
import { CodeHostRegistry } from '../../../integrations/code-host/code-host.registry';
import { CheckoutService } from '../../../steps/shared/checkout.service';
import type { StepKernel } from '../../../steps/step-kernel';
import { copyMainWithOrigin, git } from '../../../testing/git-fixture';
import { BacklogTurnWorkspace } from './turn-workspace';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'swarmloop-turn-workspace-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function workspace() {
  const checkouts = join(base, 'checkouts');
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: join(base, 'root'), CHECKOUTS_ROOT: checkouts }));
  const clock = new FakeClock();
  // A turn is not a run: the store of base tips finds no run for its key and changes nothing.
  const kernel = { config, clock, runs: { recordBaseTips: async () => undefined } } as unknown as StepKernel;
  const service = new CheckoutService(kernel, CodeHostRegistry.create(config.env, clock));
  return { checkouts, turns: new BacklogTurnWorkspace(service, config), root: join(base, 'root') };
}

/** A new commit on the remote default branch that the checkout has not fetched yet. */
function pushHead(checkout: { clone: string }, file: string): string {
  git(checkout.clone, ['switch', 'main']);
  writeFileSync(join(checkout.clone, file), 'x\n');
  git(checkout.clone, ['add', file]);
  git(checkout.clone, ['commit', '-m', file]);
  git(checkout.clone, ['push', 'origin', 'main']);
  return git(checkout.clone, ['rev-parse', 'HEAD']);
}

describe('BacklogTurnWorkspace', () => {
  it('makes a read only worktree of each repository at the fetched head of its default branch', async () => {
    const { checkouts, turns, root } = workspace();
    const web = copyMainWithOrigin(checkouts, 'web');
    copyMainWithOrigin(checkouts, 'api');
    const head = pushHead(web, 'fresh.ts');
    git(web.clone, ['reset', '--hard', 'HEAD~1']);

    const opened = await turns.open({ owner: 'ada', repositories: ['web', 'api'] }, 'turn-1');

    expect(opened.names).toEqual(['api', 'web']);
    expect(opened.workspace).toBe(join(root, 'worktrees', 'turn-1'));
    expect(opened.mounts.map((mount) => [mount.containerPath, mount.readonly])).toEqual([
      ['/work/api', true],
      ['/work/web', true],
    ]);
    expect(git(join(opened.workspace, 'web'), ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(join(opened.workspace, 'web', 'fresh.ts'))).toBe(true);
    await turns.close('turn-1');
  });

  it('removes the worktrees when the turn is closed, and closing again does nothing', async () => {
    const { checkouts, turns, root } = workspace();
    const web = copyMainWithOrigin(checkouts, 'web');
    await turns.open({ owner: 'ada', repositories: ['web'] }, 'turn-1');

    await turns.close('turn-1');
    await turns.close('turn-1');

    expect(existsSync(join(root, 'worktrees', 'turn-1'))).toBe(false);
    expect(git(web.clone, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('removes what it made and fails with the reason when a repository cannot be opened', async () => {
    const { checkouts, turns, root } = workspace();
    const web = copyMainWithOrigin(checkouts, 'web');

    await expect(turns.open({ owner: 'ada', repositories: ['web', 'missing'] }, 'turn-1')).rejects.toThrow(
      'missing is not a git checkout',
    );

    expect(existsSync(join(root, 'worktrees', 'turn-1'))).toBe(false);
    expect(git(web.clone, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});
