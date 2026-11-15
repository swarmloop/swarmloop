import { writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { join } from 'path';
import { PassThrough } from 'stream';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput } from './agent-runner';

export function fakeChild(chunks: string[], code: number): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  for (const chunk of chunks) {
    stdout.write(chunk);
  }
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', code));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, { stdout, stderr, containerName: 'box', kill: () => true });
}

export function sandbox(spawn: jest.Mock): SandboxService {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    spawn,
    stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
    kill: jest.fn().mockResolvedValue(undefined),
  } as unknown as SandboxService;
}

export function input(root: string, outputFile: string, patch: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt: 'follow up',
    workspace: root,
    outputFile,
    sessionFile: join(root, 'data', 'run1-plan-session.json'),
    runtime: 'cursor',
    model: 'm',
    agentCalls: 0,
    spentUsd: 0,
    tokensInRun: 0,
    resumeChatId: 'chat-1',
    runKey: 'run1',
    step: 'implement',
    attemptId: 'attempt-1',
    mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    mode: 'agent',
    tools: 'write',
    timeLimitMs: 60_000,
    ...patch,
  };
}

export function config(root: string, patch: Partial<SwarmloopEnv> = {}): AppConfig {
  return new AppConfig(
    testEnv({
      CURSOR_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-key',
      MAX_AGENT_CALLS: 20,
      MAX_RUN_USD: 25,
      AGENTS_PLAN: 'cursor:m',
      AGENTS_IMPLEMENT: 'cursor:m',
      AGENTS_REVIEW: 'cursor:m',
      SWARMLOOP_ROOT: root,
      ...patch,
    }),
  );
}

export function writePriceCache(root: string): void {
  for (const runtime of ['cursor', 'claude', 'codex']) {
    writeFileSync(
      join(root, 'data', `price-cache-${runtime}.json`),
      `${JSON.stringify({
        fetchedAt: new Date().toISOString(),
        prices: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
      })}\n`,
    );
  }
}
