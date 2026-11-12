import { chmodSync, existsSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
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
  const internals = publisher as unknown as { push: (...args: unknown[]) => Promise<boolean> };
  const real = internals.push.bind(publisher);
  const push = jest.spyOn(internals, 'push');
  const remoteTip = () => git(tree, ['ls-remote', origin, `refs/heads/${branch}`]).split(/\s/)[0];
  return { tree: { repo: 'demo', path: tree }, origin, publisher, push, real, remoteTip };
}

describe('RebasedPublisher unknown push result', () => {
  it('takes a push that landed before the error as done, without pushing again', async () => {
    const { tree, origin, publisher, push, real, remoteTip } = await setup();
    push.mockImplementationOnce(async (...args: unknown[]) => {
      await real(...args);
      throw new Error('connection reset');
    });
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).resolves.toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(remoteTip()).toBe(git(tree.path, ['rev-parse', 'HEAD']));
    expect(git(tree.path, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(remoteTip());
  });

  it('pushes again with the lease when the remote still has the tip the lease expects', async () => {
    const { tree, origin, publisher, push, remoteTip } = await setup();
    push.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).resolves.toBe(true);
    expect(push).toHaveBeenCalledTimes(2);
    expect(remoteTip()).toBe(git(tree.path, ['rev-parse', 'HEAD']));
  });

  it('stops with the error when the remote tip is neither of them', async () => {
    const { tree, origin, publisher, push } = await setup();
    git(tree.path, ['push', origin, `main:refs/heads/${branch}`]);
    push.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));
    await expect(publisher.pushRef(tree, branch, null, { codeHost: '', startedBy: null }, origin)).rejects.toThrow(
      'connection reset',
    );
    expect(push).toHaveBeenCalledTimes(1);
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
