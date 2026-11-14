import { EventEmitter } from 'events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { AppConfig } from '../config/env';
import { missingCredential } from '../config/agents';
import { SystemClock } from '../core/clock';
import { RunRepository } from '../history/run.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import { StepStopped } from '../agent/step-stopped';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ClaudeConnection } from '../integrations/agent-runtime/claude/claude-connection';
import { AgentProcessRunner, type AgentRunInput } from './agent-runner';
import { RunStop } from './run-stop';

const TOKEN = 'sk-ant-ann-own-token-7f3a91c2';
const SIGNED_IN_TOKEN = 'sk-ant-oat01-ann-signed-in-5d2c';
/** The real connection: it stores the fields under the env names of its runtime, as the Connections page does. */
const claude = new ClaudeConnection();

function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', 0));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    containerName: 'box',
    kill: () => true,
  });
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

function priceCache(root: string): void {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'price-cache-claude.json'),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      prices: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
    }),
  );
}

function launchInput(root: string, runKey: string): AgentRunInput {
  return {
    prompt: 'go',
    workspace: root,
    outputFile: join(root, 'data', `${runKey}-implement-output.txt`),
    sessionFile: join(root, 'data', `${runKey}-implement-session.json`),
    runtime: 'claude',
    model: 'm',
    agentCalls: 0,
    spentUsd: 0,
    tokensInRun: 0,
    resumeChatId: null,
    runKey,
    step: 'implement',
    attemptId: 'attempt-1',
    mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    mode: 'agent',
    tools: 'write',
    timeLimitMs: 60_000,
  };
}

describe('an agent launch uses the credential of the person who started the run', () => {
  let app: TestApp;
  let spawn: jest.Mock;
  let stop: RunStop;
  let runner: AgentProcessRunner;

  beforeEach(async () => {
    app = await createTestApp();
    priceCache(app.root);
    spawn = jest.fn(() => Promise.resolve(fakeChild()));
    stop = new RunStop();
    const sandbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
    } as unknown as SandboxService;
    runner = new AgentProcessRunner(
      app.app.get(AppConfig),
      new SystemClock(),
      sandbox,
      stop,
      undefined,
      app.app.get(PersonalCredentials),
      app.app.get(RunRepository),
    );
  });
  afterEach(() => app.close());

  async function startRun(key: string, startedBy: string | null): Promise<void> {
    const runs = app.app.get(RunRepository);
    await runs.saveRun(runs.newWaitingRun(key, null, startedBy));
  }

  const connect = (): Promise<void> =>
    app.app.get(PersonalCredentials).store(claude, 'ann', { ANTHROPIC_API_KEY: TOKEN }, 'ann@example.com');

  it('puts the starter token in the env of that one launch and nowhere else', async () => {
    await connect();
    await startRun('run1', 'ann');
    await runner.run(launchInput(app.root, 'run1'));
    const launch = spawn.mock.calls[0]?.[0] as { env: { name: string; value: string }[]; command: string[] };
    expect(launch.env).toEqual([{ name: 'ANTHROPIC_API_KEY', value: TOKEN }]);
    expect(launch.command.join(' ')).not.toContain(TOKEN);
    for (const file of filesUnder(app.root)) {
      expect(readFileSync(file).includes(TOKEN)).toBe(false);
    }
  });

  it('launches with the token a Claude sign-in stored, under the name its runtime reads', async () => {
    await app.app
      .get(PersonalCredentials)
      .store(claude, 'ann', { CLAUDE_CODE_OAUTH_TOKEN: SIGNED_IN_TOKEN }, 'ann@example.com');
    await startRun('run1', 'ann');
    await runner.run(launchInput(app.root, 'run1'));
    const launch = spawn.mock.calls[0]?.[0] as { env: { name: string; value: string }[] };
    expect(launch.env).toEqual([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: SIGNED_IN_TOKEN }]);
  });

  it('launches a subtask with the credential of its parent starter', async () => {
    await connect();
    await startRun('parent', 'ann');
    const runs = app.app.get(RunRepository);
    const parent = await runs.findRun('parent');
    await runs.openSubtask('child', parent?.id ?? 0, 'task-1');
    await runner.run(launchInput(app.root, 'child'));
    const launch = spawn.mock.calls[0]?.[0] as { env: { name: string; value: string }[] };
    expect(launch.env).toEqual([{ name: 'ANTHROPIC_API_KEY', value: TOKEN }]);
  });

  it('stops the run with the missing-runtime message when the person has no connection', async () => {
    await startRun('run1', 'bob');
    await expect(runner.run(launchInput(app.root, 'run1'))).rejects.toThrow(missingCredential('claude'));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('stops the run, as a Stop does, when the person disconnected after it was created', async () => {
    await connect();
    await startRun('run1', 'ann');
    await app.app.get(PersonalCredentials).disconnect('claude', 'ann');
    const launch = runner.run(launchInput(app.root, 'run1'));
    await expect(launch).rejects.toBeInstanceOf(StepStopped);
    await expect(launch).rejects.toThrow(missingCredential('claude'));
    expect(stop.halted('run1')).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});
