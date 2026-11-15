import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import * as commitGit from '../commit/commit-git';
import { RebasedPublisher } from './rebased-publisher';

const branch = 'feature/proj-80-ship-the-field';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-publisher-'));
  const { tree } = featureWorktree(root, 'proj-80');
  writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
  git(tree, ['add', 'src/field.ts']);
  git(tree, ['commit', '-m', 'field']);
  const origin = git(tree, ['remote', 'get-url', 'origin']);
  const registry = { has: () => false, forRun: () => Promise.resolve(registry) };
  const publisher = new RebasedPublisher({} as never, registry as never);
  const remoteTip = () => git(tree, ['ls-remote', origin, `refs/heads/${branch}`]).split(/\s/)[0];
  return { tree: { repo: 'demo', path: tree }, origin, publisher, remoteTip };
}

/** Records one line per push the bare repository at `origin` receives, and returns how many it has received. */
function countPushes(origin: string): () => number {
  const log = join(origin, 'pushes.log');
  const hook = join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\necho push >> "${log}"\n`);
  chmodSync(hook, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
}

/** Makes the first push of the publisher fail with an error that is not a passing outage, after it reached the remote or before; every other git call runs for real. */
function loseFirstPush(reaches: boolean): void {
  const real = commitGit.gitAt;
  let lost = false;
  jest.spyOn(commitGit, 'gitAt').mockImplementation(async (...args) => {
    if (lost || !args[1].includes('push')) return real(...args);
    lost = true;
    if (reaches) await real(...args);
    throw new Error('push result unknown');
  });
}

describe('RebasedPublisher unknown push result', () => {
  afterEach(() => jest.restoreAllMocks());

  it('takes a push that landed before the error as done, without pushing again', async () => {
    const { tree, origin, publisher, remoteTip } = await setup();
    const pushes = countPushes(origin);
    loseFirstPush(true);
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).resolves.toBe(true);
    expect(pushes()).toBe(1);
    expect(remoteTip()).toBe(git(tree.path, ['rev-parse', 'HEAD']));
    expect(git(tree.path, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(remoteTip());
  });

  it('pushes again with the lease when the remote still has the tip the lease expects', async () => {
    const { tree, origin, publisher, remoteTip } = await setup();
    const pushes = countPushes(origin);
    loseFirstPush(false);
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).resolves.toBe(true);
    expect(pushes()).toBe(1);
    expect(remoteTip()).toBe(git(tree.path, ['rev-parse', 'HEAD']));
  });

  it('stops with the error when the remote tip is neither of them', async () => {
    const { tree, origin, publisher } = await setup();
    git(tree.path, ['push', origin, `main:refs/heads/${branch}`]);
    const pushes = countPushes(origin);
    loseFirstPush(false);
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).rejects.toThrow(
      'push result unknown',
    );
    expect(pushes()).toBe(0);
  });
});

describe('RebasedPublisher host outage', () => {
  it('pushes again when the first push fails once on a 502', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { tree, origin, publisher, remoteTip } = await setup();
    const marker = join(origin, 'failed-once');
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; echo "The requested URL returned error: 502" >&2; exit 1; fi\n`,
    );
    chmodSync(hook, 0o755);
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).resolves.toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(remoteTip()).toBe(git(tree.path, ['rev-parse', 'HEAD']));
  });
});
