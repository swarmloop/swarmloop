import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import type { FootprintSource } from '../core/heavy-work';
import { SandboxService } from './sandbox.service';
import type { SandboxChild } from './sandbox.service';
import type { SandboxLaunch } from './sandbox-types';

const GB = 1024 ** 3;

type Given = Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots'>;

describe('SandboxService machine budget', () => {
  const saved = { ...process.env };
  let root: string;
  let children: SandboxChild[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-budget-')));
    mkdirSync(join(root, 'worktrees', 'k', 'demo'), { recursive: true });
    process.env.SWARMLOOP_ROOT = root;
    process.env.SANDBOX_EGRESS = 'open';
    children = [];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  /** A machine of 3 CPUs and 5 GB with a reserve of 1 CPU and 1 GB: room for one seed-sized piece. */
  function service(info: () => Promise<string> | string = () => `3 ${5 * GB}`, spawnFails = false): SandboxService {
    const sandbox = new SandboxService(new AppConfig(testEnv({ RESERVE_CPUS: 1, RESERVE_MEMORY_GB: 1 })));
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return info();
      }
      return '';
    });
    sandbox.spawnDocker = (args) => {
      if (spawnFails) {
        throw new Error('docker run failed');
      }
      const child = new EventEmitter() as SandboxChild;
      child.containerName = args[args.indexOf('--name') + 1] ?? '';
      children.push(child);
      return child;
    };
    return sandbox;
  }

  function launch(step: string, patch: Partial<Given> = {}): Given {
    return {
      runtime: 'claude',
      runKey: 'k',
      step,
      attemptId: `attempt-${step}`,
      mounts: [{ hostPath: join(root, 'worktrees', 'k', 'demo'), containerPath: '/work/demo' }],
      allowHosts: [],
      command: ['agent'],
      userId: 501,
      ...patch,
    };
  }

  async function settled(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('makes a second agent wait for the first and tells why', async () => {
    const sandbox = service();
    const first = await sandbox.spawn(launch('plan'));
    const reasons: string[] = [];
    let started = false;
    const second = sandbox.spawn(launch('review', { onWait: (reason) => reasons.push(reason) })).then((child) => {
      started = true;
      return child;
    });
    await settled();
    expect(started).toBe(false);
    expect(reasons).toEqual(['waiting for machine resources: claude agent of k']);
    expect(sandbox.snapshot()).toMatchObject({ running: ['claude agent of k'], waiting: ['claude agent of k'] });
    first.emit('close');
    await second;
    expect(started).toBe(true);
  });

  it('drops a launch that waits when its run is stopped, so no container starts for it', async () => {
    const sandbox = service();
    const first = await sandbox.spawn(launch('plan', { runKey: 'one' }));
    const waiting = sandbox.spawn(launch('review', { runKey: 'two' }));
    const rejection = expect(waiting).rejects.toThrow('the run was stopped');
    await settled();
    await sandbox.stopRun('two', 'review', 1);
    await rejection;
    first.emit('close');
    await settled();
    expect(children).toHaveLength(1);
    expect(sandbox.snapshot()).toMatchObject({ running: [], waiting: [] });
  });

  it('releases the budget when the container errors', async () => {
    const sandbox = service();
    const first = await sandbox.spawn(launch('plan'));
    first.emit('error', new Error('gone'));
    await expect(sandbox.spawn(launch('review'))).resolves.toBeDefined();
  });

  it('releases the budget when the spawn throws', async () => {
    const sandbox = service(undefined, true);
    await expect(sandbox.spawn(launch('plan'))).rejects.toThrow('docker run failed');
    expect(sandbox.snapshot().running).toEqual([]);
  });

  it('puts the memory cap on the child, and a given cap wins', async () => {
    const sandbox = service();
    const first = await sandbox.spawn(launch('plan'));
    expect(first.memoryCapBytes).toBe(3 * GB);
    first.emit('close');
    const given = await sandbox.spawn(launch('review', { memoryCapBytes: 7 * GB }));
    expect(given.memoryCapBytes).toBe(7 * GB);
  });

  it('sizes the cap from the footprint source, and falls back to the seed when it fails', async () => {
    const sandbox = service(() => `3 ${50 * GB}`);
    const peaks = Array.from({ length: 5 }, () => ({ cpuPercent: 100, rssBytes: 6 * GB }));
    const source: FootprintSource = { peaks: () => Promise.resolve(peaks) };
    sandbox.useFootprints(source);
    const learned = await sandbox.spawn(launch('plan'));
    expect(learned.memoryCapBytes).toBe(9 * GB);
    learned.emit('close');
    sandbox.useFootprints({ peaks: () => Promise.reject(new Error('no stats')) });
    const seeded = await sandbox.spawn(launch('review'));
    expect(seeded.memoryCapBytes).toBe(3 * GB);
  });

  it('starts at once without a limit when docker does not tell its size', async () => {
    const sandbox = service(() => Promise.reject(new Error('down')));
    await sandbox.spawn(launch('plan'));
    await sandbox.spawn(launch('review'));
    expect(children).toHaveLength(2);
  });

  it('starts at once without a config, with the default reserve', async () => {
    const sandbox = new SandboxService();
    sandbox.useDocker(() => Promise.reject(new Error('down')));
    sandbox.spawnDocker = () => {
      const child = new EventEmitter() as SandboxChild;
      child.containerName = 'x';
      return child;
    };
    await expect(sandbox.spawn(launch('plan'))).resolves.toBeDefined();
  });
});
