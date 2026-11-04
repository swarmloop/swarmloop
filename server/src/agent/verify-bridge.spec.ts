import { existsSync } from 'fs';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SystemClock } from '../core/clock';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { VerifyService } from '../verify/verify.service';
import { VerifyBridge } from './verify-bridge';

async function until(read: () => Promise<string | null>): Promise<string> {
  for (let turn = 0; turn < 100; turn += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('response did not arrive');
}

describe('VerifyBridge', () => {
  it('answers valid requests, ignores invalid requests, enforces its limit and removes files on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-bridge-'));
    const statePath = join(root, 'state');
    const run = jest.fn().mockResolvedValue({
      status: 'failed',
      commands: [{ command: 'npm test', exitCode: 1, tail: 'failed' }],
      warnings: [],
      installChanged: [],
      durationMs: 1,
    });
    const bridge = new VerifyBridge(
      { repos: [{ name: 'demo', path: root }], baseRef: 'origin/main', maxCalls: 1 },
      {
        clock: new SystemClock(),
        sandbox: { kill: jest.fn().mockResolvedValue(undefined) } as unknown as SandboxService,
        verifier: { run } as unknown as VerifyService,
        root,
        key: 'PROJ-1',
        step: 'implement',
        statePath,
        touch: jest.fn(),
      },
    );
    await bridge.start();
    const directory = join(statePath, '.swarmloop', 'verify');
    await writeFile(join(directory, 'bad.req'), 'demo\n');
    await writeFile(join(directory, 'abcdefghijkl.req'), 'other\n');
    await writeFile(join(directory, 'abcdefgh1234.req'), 'demo\n');
    const first = await until(async () => {
      try {
        return await readFile(join(directory, 'abcdefgh1234.res'), 'utf8');
      } catch {
        return null;
      }
    });
    expect(first).toContain('exit: 1');
    expect(run).toHaveBeenCalledTimes(1);
    await writeFile(join(directory, '1234567890ab.req'), 'demo\n');
    const limited = await until(async () => {
      try {
        return await readFile(join(directory, '1234567890ab.res'), 'utf8');
      } catch {
        return null;
      }
    });
    expect(limited).toContain('exit: 2\nverify call limit reached (1)');
    await bridge.stop();
    expect(existsSync(directory)).toBe(false);
  });

  it('keeps activity fresh while a verify request has no output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-bridge-idle-'));
    const statePath = join(root, 'state');
    let finish: (() => void) | undefined;
    const run = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ status: 'failed', commands: [], warnings: [], installChanged: [], durationMs: 1, message: 'stopped' });
        }),
    );
    const touch = jest.fn();
    const bridge = new VerifyBridge(
      { repos: [{ name: 'demo', path: root }], baseRef: 'origin/main', maxCalls: 1 },
      {
        clock: new SystemClock(),
        sandbox: { kill: jest.fn().mockResolvedValue(undefined) } as unknown as SandboxService,
        verifier: { run } as unknown as VerifyService,
        root,
        key: 'PROJ-1',
        step: 'implement',
        statePath,
        touch,
      },
    );
    await bridge.start();
    const directory = join(statePath, '.swarmloop', 'verify');
    await writeFile(join(directory, 'abcdefgh1234.req'), 'demo\n');
    await until(async () => (run.mock.calls.length === 1 ? 'running' : null));
    const before = touch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(touch.mock.calls.length).toBeGreaterThan(before);
    finish?.();
    await bridge.stop();
  });
});
