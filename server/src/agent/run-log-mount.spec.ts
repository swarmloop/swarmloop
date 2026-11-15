import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { ClaudeRuntime } from '../integrations/agent-runtime/claude/claude.runtime';
import { sandboxArgs } from '../sandbox/sandbox-launch';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { AgentLaunchPrep } from './agent-launch-prep';

const home = '/Users/dev';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'run-log-mount-'));
  const worktree = join(root, 'worktrees', 'PROJ-1', 'demo');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(root, 'data', 'run-logs', 'PROJ-2'), { recursive: true });
  const prep = new AgentLaunchPrep(new AppConfig(testEnv({ SWARMLOOP_ROOT: root })));
  const workMount = { hostPath: worktree, containerPath: '/work/demo' };
  const prepare = (prompt: string, step = 'implement') => {
    const launch = prep.prepare(
      {
        prompt,
        workspace: worktree,
        outputFile: join(root, 'out.txt'),
        sessionFile: join(root, 'session.json'),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
        agentCalls: 0,
        spentUsd: 0,
        tokensInRun: 0,
        resumeChatId: null,
        runKey: 'PROJ-1',
        step,
        attemptId: 'attempt-1',
        mounts: [workMount],
        tools: 'write',
      },
      new ClaudeRuntime(),
      false,
    );
    const sandbox: SandboxLaunch = {
      runtime: 'claude',
      runKey: 'PROJ-1',
      step,
      attemptId: 'attempt-1',
      mounts: [workMount, ...launch.mounts],
      workRoots: [join(root, 'worktrees')],
      envMasks: [],
      allowHosts: [],
      command: ['claude', ...launch.args],
      userId: 501,
      maskFile: join(root, 'empty-env'),
      statePath: launch.statePath,
    };
    return { launch, sandbox };
  };
  return { root, prepare };
}

function bindSources(args: string[]): string[] {
  return args.flatMap((arg) => (arg.match(/^type=bind,src=([^,]+),/) ?? []).slice(1));
}

describe('run log mount', () => {
  it('mounts only this run log folder read-only under data, next to the briefs and the state dir', () => {
    const { root, prepare } = setup();
    const { launch, sandbox } = prepare('x'.repeat(100_001));
    const args = sandboxArgs(sandbox, home, '');
    const logs = join(root, 'data', 'run-logs', 'PROJ-1');
    expect(args).toContain(`type=bind,src=${logs},dst=/work/logs,readonly=true`);
    const allowed = [launch.statePath, join(launch.statePath, 'briefs'), logs];
    const underData = bindSources(args).filter((src) => src.startsWith(join(root, 'data')));
    expect(underData.length).toBeGreaterThan(0);
    for (const src of underData) {
      expect(allowed).toContain(src);
    }
    const flags = launch.args.flatMap((arg, i) => (arg === '--add-dir' ? [launch.args[i + 1]] : []));
    expect(flags).toEqual(['/work/brief', '/work/logs']);
    expect(launch.args.at(-1)).toContain('/work/brief');
  });

  it('opens the log folder on a short prompt too, with the prompt last', () => {
    const { prepare } = setup();
    const { launch, sandbox } = prepare('short prompt', 'requirements');
    expect(launch.args.slice(0, 2)).toEqual(['--add-dir', '/work/logs']);
    expect(launch.args.at(-1)).toBe('short prompt');
    expect(launch.args).not.toContain('/work/brief');
    expect(sandboxArgs(sandbox, home, '').some((arg) => arg.endsWith('dst=/work/logs,readonly=true'))).toBe(true);
  });

  it('refuses a writable log mount', () => {
    const { prepare } = setup();
    const { sandbox } = prepare('short prompt');
    const mounts = sandbox.mounts.map((mount) =>
      mount.containerPath === '/work/logs' ? { ...mount, readonly: false } : mount,
    );
    expect(() => sandboxArgs({ ...sandbox, mounts }, home, '')).toThrow('sandbox mount is not allowed');
  });
});
