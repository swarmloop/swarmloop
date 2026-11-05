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

export const reply = [
  'implementation:',
  '- changed the field parser',
  '- ran unit tests',
  '',
  'summary:',
  '- changed the parser so empty fields stay',
].join('\n');

export const REFUSED_WRITE = JSON.stringify({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Write',
  message: 'Cannot write to /work/billing-api/a.php while in plan mode.',
});

export function result(responseText: string): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText,
    chatId: 'chat-1',
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
  decision: 'approve' | 'revise' | null,
  repos = 'billing-api\n',
): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'implement');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement';
  await runs.saveRun(seeded);
  const plan = decision ? { name: '', overview: '', items: ['add the field'], decision } : null;
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key, summary: 'Ship the field' }], plan }, null, 2)}\n`,
  );
  await documents.putDocument(seeded, 'repos', repos);
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

export function scripted(chunks: string[]): jest.Mock {
  const pending = [...chunks];
  return jest.fn(async () => {
    const next = pending.shift();
    if (!next) {
      throw new Error('unexpected spawn');
    }
    return fakeChild([next], 0);
  });
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

export async function writeEnv(root: string, implementTimeout = 1800000): Promise<void> {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
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
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      `IMPLEMENT_TIMEOUT_MS=${implementTimeout}`,
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      '',
    ].join('\n'),
  );
}

export function conflictedTree(root: string, key: string, repo: string): string {
  const tree = featureTree(root, key, repo);
  const clone = join(root, repo);
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
  git(tree, ['add', 'src/field.ts']);
  git(tree, ['commit', '-m', 'field']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
  git(clone, ['add', 'src/field.ts']);
  git(clone, ['commit', '-m', 'base']);
  git(clone, ['push', 'origin', 'main']);
  git(tree, ['fetch', 'origin', 'main']);
  try {
    git(tree, ['rebase', 'origin/main']);
  } catch {
    // The conflict is the setup for the visit.
  }
  return tree;
}

export function featureTree(root: string, key: string, repo: string): string {
  const clone = repoWithMain(root, repo);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, worktree, 'origin/main']);
  return worktree;
}

export function detachedTree(root: string, key: string, repo: string): string {
  const clone = repoWithMain(root, repo);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '--detach', worktree, 'origin/main']);
  return worktree;
}

export function repoWithMain(root: string, dirName: string): string {
  const clone = join(root, dirName);
  const remote = join(root, `${dirName}.git`);
  git(root, ['init', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), `${dirName}\n`);
  git(clone, ['add', 'README']);
  git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', dirName]);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  return clone;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
