import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunInput, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { REBASE_CONFLICT } from '../rebase-worktree';

const reply = ['implementation:', '- fixed the empty case', '', 'summary:', '- fixed the empty case because the return was right'].join('\n');

describe('implement-improve step', () => {
  it('stores a second implementation note and waits for code review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-70', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-70');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-70');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('billing-api');
      expect(done.message).toContain('clean');
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('agent');
      expect(input.model).toBe('grok-4.7');
      expect(input.timeLimitMs).toBe(30 * 60 * 1000);
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
      expect(input.allowHosts).toContain('registry.npmjs.org');
      expect(input.prompt).toContain('"decision": "approve"');
      expect(input.prompt).toContain('changed the field parser');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' }, order: { id: 'ASC' } });
      expect(notes).toHaveLength(2);
      expect(notes[1]?.body).toBe('- fixed the empty case\n');
      const run = await app.get(HistoryService).findRun('PROJ-70');
      expect(run?.currentStep).toBe('code-review');
      expect(run?.status).toBe('waiting');
      expect(git(worktree, ['status', '--porcelain'])).toBe('');
      await app.get(PipelineService).step('implement-improve', 'PROJ-70');
      expect(await documents.find({ where: { kind: 'implementation' } })).toHaveLength(2);
      expect((await app.get(HistoryService).findRun('PROJ-70'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('puts why it returned into the agent prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-return-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-74', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-74');
      const run = await app.get(HistoryService).findRun('PROJ-74');
      await app.get(HistoryService).putDocument(run!, 'return', '## quality\nuse theme.alpha\n');
      await app.get(HistoryService).putDocument(run!, 'handoff', '## implement\n- changed the parser so empty fields stay\n');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-74');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.prompt).toContain('Why this returned:');
      expect(input.prompt).toContain('use theme.alpha');
      expect(input.prompt).toContain('What previous steps did:');
      expect(input.prompt).toContain('## implement');
      const handoff = await app.get(HistoryService).latestBody('PROJ-74', 'handoff');
      expect(handoff).toContain('## implement');
      expect(handoff).toContain('empty fields stay');
      expect(handoff).toContain('## implement-improve');
      expect(handoff).toContain('return was right');
    } finally {
      await app.close();
    }
  });

  it('runs one review agent for every worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-multi-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-73', 'api');
    featureTree(root, 'PROJ-73', 'web');
    const agent = jest.fn().mockResolvedValue(result('implementation:\n- api fix\n- web fix\n\nsummary:\n- both match the plan\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-73', 'api\nweb\n');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-73');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/api', '/work/web']);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' }, order: { id: 'ASC' } });
      expect(notes.at(-1)?.body).toContain('- api fix');
      expect(notes.at(-1)?.body).toContain('- web fix');
    } finally {
      await app.close();
    }
  });

  it('keeps the first pass notes when the review says the first pass stands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-stands-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-76', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('implementation:\n- The first pass stands.\n\nsummary:\n- the files already match the plan\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-76');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-76');
      expect(done.exitCode).toBe(0);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' }, order: { id: 'DESC' } });
      expect(notes[0]?.body).toBe('- changed the field parser\n');
      expect((await app.get(HistoryService).findRun('PROJ-76'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('keeps an unchanged failed commit on the way to code review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-same-commit-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-77', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('summary:\n- the files already match the plan\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-77');
      await failedCommit(app, 'PROJ-77', git(worktree, ['rev-parse', 'HEAD']));
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-77');
      expect(done.exitCode).toBe(0);
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-77');
      expect(run?.currentStep).toBe('code-review');
      expect(run?.status).toBe('waiting');
      const returned = await history.latestBody('PROJ-77', 'return');
      expect(returned).toContain('FAIL api/runs.service.spec.ts expected running');
      expect(returned).not.toContain('The files were not changed. Change the code or the failing test.');
      expect(await history.latestBody('PROJ-77', 'implementation')).toBe('- changed the field parser\n');
    } finally {
      await app.close();
    }
  });

  it('reviews a dirty tree after a pipeline failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-dirty-commit-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-78', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 1;\n');
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-78');
      await failedCommit(app, 'PROJ-78', git(worktree, ['rev-parse', 'HEAD']));
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-78');
      expect(done.exitCode).toBe(0);
      expect((await app.get(HistoryService).findRun('PROJ-78'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('reviews when the commit is not the one CI failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-other-commit-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-79', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('summary:\n- the files already match the plan\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-79');
      await failedCommit(app, 'PROJ-79', 'abc');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-79');
      expect(done.exitCode).toBe(0);
      expect((await app.get(HistoryService).findRun('PROJ-79'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('keeps the first pass notes and advances when the review writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-empty-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-71', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('The first pass already matches the plan.'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-71');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-71');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('implement-improve done');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' }, order: { id: 'DESC' } });
      expect(notes[0]?.body).toBe('- changed the field parser\n');
      const run = await app.get(HistoryService).findRun('PROJ-71');
      expect(run?.currentStep).toBe('code-review');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('fails when the second pass commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-commit-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-72', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      git(worktree, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'nope']);
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-72');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-72');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('billing-api was committed');
      expect((await app.get(HistoryService).findRun('PROJ-72'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('continues the implement chat with the follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-resume-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-73', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-73-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'implement-chat', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-73');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-73');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('implement-chat');
      expect(input.prompt).toContain('Check the change for logical and technical gaps and fix only those');
      expect(input.prompt).not.toContain('# Implement improve');
      expect(input.prompt).not.toContain('Ship the field');
      expect(input.prompt).not.toContain('add the field');
      expect(input.prompt).not.toContain('changed the field parser');
      expect(input.prompt).not.toContain('What previous steps did');
    } finally {
      await app.close();
    }
  });

  it('reviews while a rebase marker is pending and leaves that marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-catchup-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-74', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-74');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-74');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-74');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.prompt).toContain('logical and technical gaps');
      expect(input.prompt).not.toContain('A rebase is in progress');
      expect((await history.latestBody('PROJ-74', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect((await history.findRun('PROJ-74'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('reviews a diverged repo without starting a rebase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-stop-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-75', 'billing-api');
    const clone = join(root, 'PROJ-75-billing-api');
    git(clone, ['config', 'user.email', 'dev@example.com']);
    git(clone, ['config', 'user.name', 'Dev']);
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(worktree, ['add', 'src/field.ts']);
    git(worktree, ['commit', '-m', 'field']);
    mkdirSync(join(clone, 'src'), { recursive: true });
    writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(clone, ['add', 'src/field.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-75');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-75');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-75');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.prompt).toContain('logical and technical gaps');
      expect(input.prompt).not.toContain('finish the checklist in this visit');
      const fresh = await history.findRun('PROJ-75');
      expect(fresh?.currentStep).toBe('code-review');
      expect(fresh?.status).toBe('waiting');
      expect((await history.latestBody('PROJ-75', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect(git(worktree, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
    } finally {
      await app.close();
    }
  });
});

function result(responseText: string): AgentRunResult {
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

async function boot(root: string, agent: jest.Mock) {
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}

async function failedCommit(app: Awaited<ReturnType<typeof boot>>, key: string, sha: string): Promise<void> {
  const history = app.get(HistoryService);
  const run = await history.findRun(key);
  await history.putDocument(run!, 'pipeline_ref', `project: acme/billing-api\nref: feature/${key}-ship-the-field\nsha: ${sha}\n`);
  await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL api/runs.service.spec.ts expected running\n');
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, repos = 'billing-api\n'): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'implement-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement-improve';
  await history.saveRun(seeded);
  await history.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key, summary: 'Ship the field' }], plan: { name: '', overview: '', items: ['add the field'], decision: 'approve' } }, null, 2)}\n`,
  );
  await history.putDocument(seeded, 'repos', repos);
  await history.putDocument(seeded, 'implementation', '- changed the field parser\n');
}

async function writeEnv(root: string): Promise<void> {
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
      'CURSOR_API_KEY=',
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
      'IMPLEMENT_TIMEOUT_MS=1800000',
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

function featureTree(root: string, key: string, repo: string): string {
  const clone = repoWithMain(root, `${key}-${repo}`);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, worktree, 'origin/main']);
  return worktree;
}

function repoWithMain(root: string, dirName: string): string {
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
