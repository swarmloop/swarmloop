import 'reflect-metadata';

import { execFileSync } from 'child_process';

import { EventEmitter } from 'events';

import { Test } from '@nestjs/testing';

import { mkdirSync, writeFileSync } from 'fs';

import { writeFile } from 'fs/promises';

import { join } from 'path';

import { PassThrough } from 'stream';

import { SwarmloopConfigModule } from '../../config/config.module';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunResult } from '../../agent/agent-runner';

import { AGENT_RUNNER } from '../../agent/agent-runner';

import { PipelineModule } from '../../pipeline/pipeline.module';

import { SandboxService } from '../../sandbox/sandbox.service';

export const REFUSED_WRITE = JSON.stringify({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Write',
  message: 'Cannot write to /work/billing-api/a.php while in plan mode.',
});

export function reply(step: string, decision: 'ok' | 'return'): string {
  return `${step}\n\ndecision: ${decision}\n`;
}

export function result(responseText: string, step = 'code-review'): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText,
    chatId: step,
    tokensIn: 10,
    tokensOut: 4,
    usd: 0.01,
    killReason: null,
    exitCode: 0,
    resumed: false,
    calls: 1,
    samples: [],
    durationMs: 5,
    startedAt: now,
    finishedAt: now,
  };
}

export async function boot(root: string, agent: jest.Mock) {
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}

export async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  attemptsReview = 0,
  agentCalls = 0,
): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'code-review');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement-improve';
  seeded.attemptsReview = attemptsReview;
  seeded.agentCalls = agentCalls;
  await runs.saveRun(seeded);
  await documents.putDocument(seeded, 'requirements', `${JSON.stringify({ prompt: 'Ship the field\n' })}\n`);
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
  await documents.putDocument(seeded, 'implementation', '- changed the field parser\n');
}

export async function bootLive(root: string, spawn: jest.Mock): ReturnType<typeof boot> {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'price-cache-cursor.json'),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), prices: {} })}\n`,
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(SandboxService)
    .useValue({
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
      kill: jest.fn().mockResolvedValue(undefined),
    })
    .compile();
}

export function reviewSpawn(succeedOn: number): jest.Mock {
  let security = 0;
  return jest.fn(async (launch: { step: string }) => {
    if (launch.step === 'code-review-security') {
      security += 1;
      if (succeedOn > 0 && security >= succeedOn) {
        return fakeChild([doneStream('security-finished\n\ndecision: ok\n')], 0);
      }
      return fakeChild([chatStream('security-chat', `security-attempt-${security}`)], 0);
    }
    if (launch.step === 'code-review-report') {
      return fakeChild([doneStream('The checks are in.\n')], 0);
    }
    const name = launch.step.replace('code-review-', '');
    return fakeChild([doneStream(`${name}\n\ndecision: ok\n`)], 0);
  });
}

export function launches(spawn: jest.Mock, step: string): unknown[][] {
  return spawn.mock.calls.filter((call) => (call[0] as { step?: string }).step === step);
}

export function launchedPrompt(call: unknown[] | undefined): string {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  return command[command.length - 1] ?? '';
}

export function resumeArg(call: unknown[] | undefined): string | null {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  const at = command.indexOf('--resume');
  return at < 0 ? null : (command[at + 1] ?? null);
}

export function chatStream(chatId: string, note?: string): string {
  const noteLine = note ? `${JSON.stringify({ type: 'thinking', text: note })}\n` : '';
  return `${noteLine}${JSON.stringify({ session_id: chatId })}\n`;
}

export function doneStream(text: string): string {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

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

export async function writeEnv(
  root: string,
  checkoutsRoot?: string,
  maxLaunches = 3,
  reviewTimeout = 900000,
): Promise<void> {
  await writeFile(
    join(root, '.env'),
    [
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=',
      'GITLAB_TOKEN=',
      'GITHUB_BASE_URL=',
      'GITHUB_TOKEN=',
      'CURSOR_API_KEY=test-key',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      `MAX_LAUNCHES=${maxLaunches}`,
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      `CODE_REVIEW_TIMEOUT_MS=${reviewTimeout}`,
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'AGENTS_PLAN=cursor:opus-5.5-extra-high',
      'AGENTS_IMPLEMENT=cursor:grok-4.7',
      'AGENTS_REVIEW=cursor:opus-5.5-extra-high',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      checkoutsRoot === undefined ? '' : `CHECKOUTS_ROOT=${checkoutsRoot}`,
      '',
    ].join('\n'),
  );
}

export function repoWithBranch(root: string, dirName: string): string {
  const clone = join(root, dirName);
  const remote = join(root, `${dirName}.git`);
  git(root, ['init', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), 'base\n');
  git(clone, ['add', 'README']);
  git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', 'base']);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['checkout', '-b', 'feature/other']);
  writeFileSync(join(clone, 'NEXT'), 'other\n');
  git(clone, ['add', 'NEXT']);
  git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', 'other']);
  git(clone, ['push', '-u', 'origin', 'feature/other']);
  git(clone, ['checkout', '-b', 'dirty']);
  writeFileSync(join(clone, 'local.txt'), 'noise\n');
  return clone;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
