import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SandboxService } from '../sandbox/sandbox.service';
import { FakeCliSandbox } from '../testing/fake-cli';
import { SandboxConnectionProbe } from './connection-probe';

describe('SandboxConnectionProbe.check', () => {
  let root: string;
  let sandbox: FakeCliSandbox;
  let probe: SandboxConnectionProbe;
  const check = () => probe.check('codex', [{ name: 'CODEX_AUTH', value: 'x' }], ['codex', 'login', 'status']);

  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'connection-probe-'));
    sandbox = new FakeCliSandbox();
    probe = new SandboxConnectionProbe(
      new AppConfig(testEnv({ SWARMLOOP_ROOT: root })),
      sandbox as unknown as SandboxService,
      new FakeClock(),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('gives the output and removes the container when the command ends', async () => {
    sandbox.script = (child) => {
      child.say('ok\n');
      child.exit(0);
    };
    const pending = check();
    await jest.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ ok: true, output: 'ok' });
    expect(sandbox.removed).toEqual([sandbox.children[0].containerName]);
  });

  it('ends with an error and removes the container when the command hangs', async () => {
    const pending = check();
    const outcome = expect(pending).rejects.toThrow('the check timed out');
    await jest.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(sandbox.removed).toEqual([sandbox.children[0].containerName]);
  });

  it('removes the container when the process cannot run', async () => {
    sandbox.script = (child) => child.crash('docker went away');
    const pending = check();
    const outcome = expect(pending).rejects.toThrow('docker went away');
    await jest.advanceTimersByTimeAsync(0);
    await outcome;
    expect(sandbox.removed).toHaveLength(1);
  });

  it('gives two checks at once two container names', async () => {
    const first = check();
    const second = check();
    const outcomes = [expect(first).rejects.toThrow(), expect(second).rejects.toThrow()];
    await jest.advanceTimersByTimeAsync(60_000);
    await Promise.all(outcomes);
    const [one, two] = sandbox.children.map((child) => child.containerName);
    expect(one).not.toBe(two);
  });
});
