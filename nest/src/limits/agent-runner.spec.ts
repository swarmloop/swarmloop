import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { ConfigService } from '@nestjs/config';
import { SandboxService } from '../sandbox/sandbox.service';
import { AgentProcessRunner, AgentRunInput } from './agent-runner';
import { RunStop } from './run-stop';

const PREVIOUS = 'previous-visit-transcript\n';

describe('AgentProcessRunner resume output', () => {
  it('returns only the new stream and keeps the previous transcript in the output file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-resume-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(outputFile, PREVIOUS);
    writePriceCache(root);
    const spawn = jest.fn(async () => fakeChild(['visit-new-stream\n'], 0));
    const runner = new AgentProcessRunner(config(root), sandbox(spawn), new RunStop());
    const result = await runner.run(input(root, outputFile));
    expect(result.output).toContain('visit-new-stream');
    expect(result.output).not.toContain('previous-visit-transcript');
    expect(await readFile(outputFile, 'utf8')).toMatch(/^previous-visit-transcript\n/);
  });

  it('keeps both new streams from a bare-log crash retry and leaves the previous transcript out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-retry-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(outputFile, PREVIOUS);
    writePriceCache(root);
    const scripts = [
      { chunks: [] as string[], code: 1 },
      { chunks: ['second-stream\n'], code: 0 },
    ];
    const spawn = jest.fn(async () => {
      const next = scripts.shift();
      if (!next) {
        throw new Error('unexpected spawn');
      }
      return fakeChild(next.chunks, next.code);
    });
    const runner = new AgentProcessRunner(config(root), sandbox(spawn), new RunStop());
    const result = await runner.run(input(root, outputFile));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('process exited 1');
    expect(result.output).toContain('second-stream');
    expect(result.output).not.toContain('previous-visit-transcript');
    expect(await readFile(outputFile, 'utf8')).toMatch(/^previous-visit-transcript\n/);
  });
});

function fakeChild(chunks: string[], code: number): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  for (const chunk of chunks) {
    stdout.write(chunk);
  }
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: any[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', code));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, { stdout, stderr, containerName: 'box', kill: () => true });
}

function sandbox(spawn: jest.Mock): SandboxService {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    spawn,
    stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
    kill: jest.fn().mockResolvedValue(undefined),
  } as unknown as SandboxService;
}

function input(root: string, outputFile: string): AgentRunInput {
  return {
    prompt: 'follow up',
    workspace: root,
    outputFile,
    sessionFile: join(root, 'data', 'run1-plan-session.json'),
    model: 'm',
    agentCalls: 0,
    spentUsd: 0,
    tokensInRun: 0,
    resumeChatId: 'chat-1',
    runKey: 'run1',
    step: 'implement',
    mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    mode: 'agent',
    timeLimitMs: 60_000,
  };
}

function config(root: string): ConfigService {
  const env: Record<string, string | number> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    CURSOR_API_KEY: 'test-key',
    ANTHROPIC_API_KEY: 'test-key',
    MAX_AGENT_CALLS: 20,
    MAX_RETURNS: 3,
    MAX_PIPELINE_RETURNS: 6,
    MAX_LAUNCHES: 3,
    MAX_RUN_USD: 25,
    IDLE_TIMEOUT_MS: 900000,
    TICK_MS: 15000,
    REQUIREMENTS_TIMEOUT_MS: 600000,
    RESEARCH_TIMEOUT_MS: 900000,
    PLAN_TIMEOUT_MS: 1200000,
    IMPLEMENT_TIMEOUT_MS: 1800000,
    CODE_REVIEW_TIMEOUT_MS: 900000,
    MERGE_REQUEST_TIMEOUT_MS: 600000,
    PIPELINE_TIMEOUT_MS: 1800000,
    PIPELINE_START_TIMEOUT_MS: 180000,
    MODEL_RESEARCH: 'm',
    MODEL_PLAN: 'm',
    MODEL_IMPLEMENT: 'm',
    SWARMLOOP_API_PORT: 3920,
    SWARMLOOP_API_HOST: '127.0.0.1',
    SWARMLOOP_ROOT: root,
  };
  return {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) {
        throw new Error(key);
      }
      return value;
    },
  } as ConfigService;
}

function writePriceCache(root: string): void {
  writeFileSync(
    join(root, 'data', 'price-cache-cursor.json'),
    `${JSON.stringify({
      fetchedAt: new Date().toISOString(),
      prices: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
    })}\n`,
  );
}
