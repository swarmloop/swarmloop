import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { CheckCommandEntity, RunEntity } from '../history/entities';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { copiedRepo, sharedRepo } from './project-repo.spec-helpers';
import type { EnvironmentRecord } from './environment-types';
import { ENVIRONMENT, ProjectEnvironments } from './project-environments';

export const manifest = {
  version: 1,
  image: 'node:22-bookworm-slim',
  setup: 'npm ci',
  checks: ['npm test'],
  cache: ['/home/sandbox/.npm'],
};

export function setup(
  options: {
    writes?: boolean;
    probe?: string | Error;
    setupCode?: number;
    checkCode?: number;
    /** The exit code of one check command, by its text. */
    checkExit?: (command: string) => number;
    /** How many turns of the event loop a check container stays alive. */
    checkTurns?: number;
    /** The lines a check writes. */
    checkLines?: number;
    config?: unknown;
    onCheck?: (repo: string) => void;
    imageId?: () => string;
    /** The runtime of the server's agent lists. An agent's own runtime never comes from it. */
    RUNTIME?: 'claude' | 'codex';
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-env-root-'));
  const repo = (options.writes ? copiedRepo : sharedRepo)({
    '.swarmloop.json': JSON.stringify(options.config ?? manifest),
  });
  const stored: { kind: string; body: string }[] = [];
  const documents = {
    putDocument: jest.fn((_run: RunEntity, kind: string, body: string) => {
      stored.push({ kind, body });
      return Promise.resolve();
    }),
    latestBody: jest.fn((_key: string, kind: string) =>
      Promise.resolve([...stored].reverse().find((item) => item.kind === kind)?.body ?? null),
    ),
  };
  const spawned: SandboxLaunch[] = [];
  const alive = { now: 0, max: 0 };
  const run = jest.fn((args: string[]) => {
    const [first, second] = args;
    if (first === 'image' && second === 'inspect' && args.includes('{{.Id}}')) {
      return Promise.resolve(
        (args.at(-1) === manifest.image ? options.imageId?.() : undefined) ??
          'sha256:0123456789abcdef0123456789abcdef\n',
      );
    }
    if (first === 'image' && second === 'inspect' && args.includes('{{json .Config.Env}}')) {
      return Promise.resolve('["PATH=/usr/local/bin:/usr/bin:/bin"]');
    }
    if (first === 'run' && args.includes('-c') && (args.at(-1) ?? '').includes('certs=')) {
      return options.probe instanceof Error
        ? Promise.reject(options.probe)
        : Promise.resolve(options.probe ?? 'certs=no\nv1\n');
    }
    if (first === 'run' && (args.at(-1) ?? '').startsWith('test -f')) {
      return Promise.resolve('yes\n');
    }
    return Promise.resolve('');
  });
  const rows: CheckCommandEntity[] = [];
  const commands = {
    add: jest.fn((draft: Partial<CheckCommandEntity>) => {
      const row = {
        id: rows.length + 1,
        status: 'waiting',
        skipped: 0,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        ...draft,
      } as CheckCommandEntity;
      rows.push(row);
      return Promise.resolve(row);
    }),
    save: jest.fn((row: CheckCommandEntity) => Promise.resolve(row)),
  };
  const sandbox = {
    run,
    stats: jest.fn().mockResolvedValue({ cpuPercent: 5, rssBytes: 1024 }),
    stateDaemonPath: jest.fn((path: string) => Promise.resolve(path)),
    kill: jest.fn().mockResolvedValue(undefined),
    spawn: jest.fn((launch: SandboxLaunch) => {
      spawned.push(launch);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        containerName: 'swarmloop-r1-implement',
      });
      const isCheck = launch.allowHosts.length === 0;
      if (isCheck) {
        alive.now += 1;
        alive.max = Math.max(alive.max, alive.now);
      }
      setImmediate(() => {
        if (isCheck) {
          options.onCheck?.(repo);
        }
        child.stdout.write('added 12 packages\n');
        child.stderr.write('npm warn old\n');
        if (isCheck && options.checkLines) {
          child.stdout.write(`${Array.from({ length: options.checkLines }, (_, line) => `line ${line}`).join('\n')}\n`);
        }
        const code = isCheck
          ? (options.checkExit?.(launch.project?.shell ?? '') ?? options.checkCode ?? 0)
          : (options.setupCode ?? 0);
        // A check container stays alive for a few turns of the event loop, so containers overlap when they may.
        const close = (turns: number): void => {
          if (turns > 0) {
            setImmediate(() => close(turns - 1));
            return;
          }
          if (isCheck) {
            alive.now -= 1;
          }
          child.emit('close', code);
        };
        close(isCheck ? (options.checkTurns ?? 0) : 0);
      });
      return Promise.resolve(child);
    }),
  };
  const live = { log: jest.fn(), changed: jest.fn() };
  const listed = `${options.RUNTIME ?? 'codex'}:m`;
  const env = testEnv({
    AGENTS_PLAN: listed,
    AGENTS_IMPLEMENT: listed,
    AGENTS_REVIEW: listed,
    SWARMLOOP_ROOT: root,
  });
  const service = new ProjectEnvironments({
    env: () => env,
    clock: new FakeClock(),
    sandbox: sandbox as unknown as ConstructorParameters<typeof ProjectEnvironments>[0]['sandbox'],
    documents,
    commands,
    live,
  });
  const input = {
    run: {} as RunEntity,
    key: 'r1',
    step: 'implement',
    mounts: [{ hostPath: repo, containerPath: '/work' }],
    runtime: 'codex' as const,
  };
  const records = () =>
    stored.filter((item) => item.kind === ENVIRONMENT).map((item) => JSON.parse(item.body) as EnvironmentRecord);
  return { service, sandbox, input, spawned, records, run, stored, live, rows, alive, root };
}
