import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { SandboxService } from './sandbox.service';
import type { SandboxChild } from './sandbox.service';
import type { SandboxLaunch } from './sandbox-types';

const GB = 1024 ** 3;

type Given = Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots'>;

const projectLaunch = {
  image: 'swarmloop-env-demo:0123456789ab',
  cliVolume: 'swarmloop-cli-claude-0123456789ab',
  path: '/usr/local/bin:/usr/bin:/bin',
  certFile: true,
  caches: [],
  shell: 'npm test',
};

describe('SandboxService memory cap', () => {
  const saved = { ...process.env };
  let root: string;
  let children: SandboxChild[];
  let runs: string[][];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-cap-')));
    mkdirSync(join(root, 'worktrees', 'k', 'demo'), { recursive: true });
    process.env.SWARMLOOP_ROOT = root;
    process.env.SANDBOX_EGRESS = 'open';
    children = [];
    runs = [];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  /** 3 GB with a reserve of 1 GB: small enough that a queue would hold work back. */
  function service(
    info: (args: string[]) => Promise<string> | string = () => `${3 * GB}`,
    spawnFails = false,
  ): SandboxService {
    const sandbox = new SandboxService(new AppConfig(testEnv({ RESERVE_MEMORY_GB: 1 })));
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return info(args);
      }
      return '';
    });
    sandbox.spawnDocker = (args) => {
      runs.push(args);
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

  it('starts three checks and five agents of different runs at once', async () => {
    const sandbox = service();
    const checks = [0, 1, 2].map((index) =>
      sandbox.spawn(launch(`checks-${index}`, { runKey: `check-run-${index}`, command: [], project: projectLaunch })),
    );
    const agents = [0, 1, 2, 3, 4].map((index) =>
      sandbox.spawn(launch(`implement-${index}`, { runKey: `run-${index}` })),
    );
    await expect(Promise.all([...checks, ...agents])).resolves.toHaveLength(8);
    expect(children).toHaveLength(8);
  });

  it('gives every container the same memory cap and the lower CPU weight', async () => {
    const sandbox = service();
    const agent = await sandbox.spawn(launch('plan'));
    const check = await sandbox.spawn(launch('checks-0', { command: [], project: projectLaunch }));
    expect(runs).toHaveLength(2);
    for (const args of runs) {
      expect(args[args.indexOf('--memory') + 1]).toBe(`${2 * GB}b`);
      expect(args[args.indexOf('--cpu-shares') + 1]).toBe('512');
    }
    expect(agent.memoryCapBytes).toBe(2 * GB);
    expect(check.memoryCapBytes).toBe(2 * GB);
  });

  it('starts without a memory cap when docker does not tell its size', async () => {
    const sandbox = service(() => Promise.reject(new Error('down')));
    const child = await sandbox.spawn(launch('plan'));
    expect(runs[0]).not.toContain('--memory');
    expect(child.memoryCapBytes).toBeUndefined();
  });

  it('asks docker again on the next launch after it gave no answer', async () => {
    let answer: string | Error = new Error('down');
    const sandbox = service(() => (answer instanceof Error ? Promise.reject(answer) : answer));
    await sandbox.spawn(launch('plan'));
    answer = `${5 * GB}`;
    const later = await sandbox.spawn(launch('review'));
    expect(later.memoryCapBytes).toBe(4 * GB);
  });

  it('releases nothing and leaves nothing behind when the spawn throws', async () => {
    const sandbox = service(undefined, true);
    await expect(sandbox.spawn(launch('plan'))).rejects.toThrow('docker run failed');
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
