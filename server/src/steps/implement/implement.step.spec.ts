import { resultAnswer } from '../../testing/result-answer';
import { handoffText } from '../shared/handoff';
import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import type { Repository } from 'typeorm';

import { DocumentEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { REBASE_CONFLICT } from '../../git/rebase';

import { EnvironmentService } from '../../environment/environment.service';

import { SwarmloopError } from '../../core/swarmloop-error';

import { RequiredCheckFailed } from '../../environment/project-environments';

import {
  implAnswer,
  rebaseReply,
  reply,
  REFUSED_WRITE,
  result,
  boot,
  bootOnce,
  seed,
  writeEnv,
  featureTree,
  git,
} from './implement.step.spec-helpers';

const once = bootOnce();

describe('implement step', () => {
  it.each(['fixed', 'still-failing', 'infrastructure'] as const)(
    'returns post-rebase check errors to implementation: %s',
    async (mode) => {
      const key = `PROJ-18${['fixed', 'still-failing', 'infrastructure'].indexOf(mode) + 5}`;
      const tree = once.conflicted(key, 'billing-api');
      const agent = jest.fn(async (input: AgentRunInput) => {
        if (input.prompt.includes('The commit being replayed is')) {
          writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 3;\n');
          return result(rebaseReply);
        }
        writeFileSync(join(tree, 'src', 'fixed.ts'), 'export const fixed = true;\n');
        return result(reply);
      });
      const app = once.app();
      once.use(agent);
      await seed(app, key, 'approve');
      const documents = app.get(DocumentRepository);
      const runs = app.get(RunRepository);
      const run = (await runs.findRun(key))!;
      await documents.putDocument(run, 'implementation', '- existing implementation\n');
      await documents.putDocument(run, REBASE_CONFLICT, 'pending\n');
      const failure =
        'billing-api: required check failed (exit 1):\n$ npm run typecheck\nCannot find module ../shared/repo-names';
      let checks = 0;
      jest.spyOn(app.get(EnvironmentService), 'check').mockImplementation(async () => {
        checks += 1;
        if (mode === 'infrastructure') throw new SwarmloopError('sandbox unavailable');
        if (checks > 1 && mode === 'fixed') return { passed: 0, total: 0 };
        await documents.putDocument(run, 'return', `## checks\n${failure}\n`);
        throw new RequiredCheckFailed(failure);
      });
      // implement resolves the conflict and hands the rebased code to the checks step.
      const first = await app.get(PipelineService).step('implement', key);
      expect(first.exitCode).toBe(0);
      expect(await documents.latestBody(key, 'return')).toBeNull();
      expect((await runs.findRun(key))?.agentCalls).toBe(1);
      expect(
        git(`${once.clone(key, 'billing-api')}.git`, ['rev-parse', `refs/heads/feature/${key}-ship-the-field`]),
      ).toBe(git(tree, ['rev-parse', 'HEAD']));
      expect((await documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await runs.findRun(key))?.currentStep).toBe('checks');
      const head = git(tree, ['rev-parse', 'HEAD']);
      const second = await app.get(PipelineService).step('checks', key);
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      if (mode === 'infrastructure') {
        expect(second.exitCode).toBe(1);
        expect(second.message).toContain('sandbox unavailable');
        expect((await app.get(RunRepository).findRun(key))?.agentCalls).toBe(1);
        return;
      }
      expect((await runs.findRun(key))?.currentStep).toBe('implement');
      const third = await app.get(PipelineService).step('implement', key);
      expect(third.exitCode).toBe(0);
      expect((await app.get(RunRepository).findRun(key))?.agentCalls).toBe(2);
      expect(agent.mock.calls[1][0].prompt).toContain(failure);
      expect((await documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await runs.findRun(key))?.currentStep).toBe('checks');
      await app.get(PipelineService).step('checks', key);
      expect((await runs.findRun(key))?.currentStep).toBe(mode === 'fixed' ? 'code-review' : 'implement');
    },
  );

  it('writes the checklist on the feature branch and waits for review', async () => {
    const worktree = once.tree('PROJ-60', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-60', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-60');
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
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-60'))!.id },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe('- changed the field parser\n- ran unit tests\n');
    const handoff = await documents.find({
      where: { kind: 'handoff', runId: (await app.get(RunRepository).findRun('PROJ-60'))!.id },
    });
    expect(handoffText(handoff[0]?.body ?? null)).toContain('## implement');
    expect(handoffText(handoff[0]?.body ?? null)).toContain('empty fields stay');
    const run = await app.get(RunRepository).findRun('PROJ-60');
    expect(run?.currentStep).toBe('implement-improve');
    expect(run?.status).toBe('waiting');
    expect(git(worktree, ['status', '--porcelain'])).toBe('');
    await app.get(PipelineService).step('implement', 'PROJ-60');
    expect(
      await documents.find({
        where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-60'))!.id },
      }),
    ).toHaveLength(1);
    expect((await app.get(RunRepository).findRun('PROJ-60'))?.currentStep).toBe('implement-improve');
  });

  it('starts a fresh chat with the full prompt when the agent state of the stored chat is gone', async () => {
    const root = once.root();
    once.tree('PROJ-69', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-69-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-69', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-69');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId).toBeNull();
    expect(input.prompt).toContain('# Implement');
    expect(input.prompt).toContain('Ship the field');
  });

  it('continues the implement chat with a short prompt', async () => {
    const root = once.root();
    once.tree('PROJ-691', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-691', 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-691-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-691', 'approve');
    const pipeline = app.get(PipelineService);
    const detached = jest.spyOn(pipeline, 'startDetached').mockResolvedValue({ exitCode: 0, message: 'started' });
    await pipeline.replay('PROJ-691', 'implement', 'Move real bodies, not re-export facades.');
    const run = (await app.get(RunRepository).findRun('PROJ-691'))!;
    await app.get(DocumentRepository).putDocument(run, 'instructions:plan', 'Unrelated planning instruction');
    detached.mockRestore();
    const done = await pipeline.step('implement', 'PROJ-691');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId).toBe('plan-chat');
    expect(input.prompt).toContain('Latest user instructions:\nMove real bodies, not re-export facades.');
    expect(input.prompt).not.toContain('Unrelated planning instruction');
    expect(input.prompt).toContain('Read a file before editing it');
    expect(input.prompt).toContain('add the field');
    expect(input.prompt).not.toContain('# Implement');
    expect(input.prompt).not.toContain('Ship the field');
    expect(input.prompt).not.toContain('Package registries');
    expect(input.prompt).not.toContain('What previous steps did');
  });

  it('carries the return notes in the continued follow-up', async () => {
    const root = once.root();
    once.tree('PROJ-95', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-95', 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-95-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-95', 'approve');
    const run = (await app.get(RunRepository).findRun('PROJ-95'))!;
    await app.get(DocumentRepository).putDocument(run, 'return', '## quality\nuse theme.alpha\n');
    await app.get(PipelineService).step('implement', 'PROJ-95');
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId).toBe('plan-chat');
    expect(input.prompt).toContain('use theme.alpha');
  });

  it('starts a fresh chat when only the plan session remains', async () => {
    const root = once.root();
    once.tree('PROJ-68', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-68', 'plan'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-68-plan-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-68', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-68');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId ?? null).toBeNull();
    expect(input.prompt).toContain('# Implement');
    expect(input.prompt).toContain('Ship the field');
    expect(input.prompt).toContain('Package registries');
  });

  it('fails when the agent commits', async () => {
    const worktree = once.tree('PROJ-66', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      git(worktree, [
        '-c',
        'user.email=dev@example.com',
        '-c',
        'user.name=Dev',
        'commit',
        '--allow-empty',
        '-m',
        'nope',
      ]);
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-66', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-66');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('billing-api was committed');
    const run = await app.get(RunRepository).findRun('PROJ-66');
    expect(run?.currentStep).toBe('implement');
    expect(run?.status).toBe('failed');
  });

  it('does not start the agent when the plan is not approved', async () => {
    once.tree('PROJ-61', 'billing-api');
    const agent = jest.fn();
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-61', 'revise');
    const done = await app.get(PipelineService).step('implement', 'PROJ-61');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('plan is not approved');
    expect((await app.get(RunRepository).findRun('PROJ-61'))?.agentCalls).toBe(0);
    const run = await app.get(RunRepository).findRun('PROJ-61');
    expect(run?.currentStep).toBe('implement');
    expect(run?.status).toBe('failed');
  });

  it('does not start the agent when the plan body is empty', async () => {
    once.tree('PROJ-64', 'billing-api');
    const agent = jest.fn();
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-64', null);
    const done = await app.get(PipelineService).step('implement', 'PROJ-64');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('plan is missing');
    expect((await app.get(RunRepository).findRun('PROJ-64'))?.agentCalls).toBe(0);
  });

  it('does not start the agent when the worktree is not a git checkout', async () => {
    const root = once.root();
    mkdirSync(join(root, 'worktrees', 'PROJ-65', 'billing-api'), { recursive: true });
    const agent = jest.fn();
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-65', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-65');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('billing-api branch failed');
    expect((await app.get(RunRepository).findRun('PROJ-65'))?.agentCalls).toBe(0);
  });

  it('does not start the agent when the feature branch is missing', async () => {
    once.detached('PROJ-62', 'billing-api');
    const agent = jest.fn();
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-62', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-62');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('billing-api branch is missing');
    expect((await app.get(RunRepository).findRun('PROJ-62'))?.agentCalls).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-62'))?.status).toBe('failed');
  });

  it('runs one agent for every worktree', async () => {
    once.tree('PROJ-67', 'api');
    once.tree('PROJ-67', 'web');
    const agent = jest
      .fn()
      .mockResolvedValue(result(implAnswer(['api field', 'web button'], ['both follow the plan'])));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-67', 'approve', 'api\nweb\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-67');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-67'))?.agentCalls).toBe(1);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/api', '/work/web']);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-67'))!.id },
    });
    expect(notes[0]?.body).toContain('- api field');
    expect(notes[0]?.body).toContain('- web button');
  });

  it('puts why it returned into the agent prompt', async () => {
    once.tree('PROJ-681', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-681', 'approve');
    const run = await app.get(RunRepository).findRun('PROJ-681');
    await app.get(DocumentRepository).putDocument(run!, 'review_quality', 'use theme.alpha\ndecision: return\n');
    await app.get(DocumentRepository).putDocument(run!, 'handoff', '## plan\n- add the field\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-681');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Why this returned:');
    expect(input.prompt).toContain('## quality');
    expect(input.prompt).toContain('use theme.alpha');
    expect(input.prompt).toContain('What previous steps did:');
    expect(input.prompt).toContain('## plan');
  });

  it('fails when the summary is missing', async () => {
    once.tree('PROJ-692', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(result(resultAnswer('Done.', { implementation: ['changed the field parser'] })));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-692', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-692');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('summary: "summary" is required');
  });

  it('still fails the implement step when a write was refused', async () => {
    once.tree('PROJ-70', 'billing-api');
    const agent = jest.fn().mockResolvedValue({ ...result(reply), output: REFUSED_WRITE });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-70', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-70');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('implement failed: Cannot write to /work/billing-api/a.php while in plan mode.');
  });

  it('fails when the implementation notes are empty', async () => {
    once.tree('PROJ-63', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(implAnswer([], ['nothing to change'])));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-63', 'approve');
    const done = await app.get(PipelineService).step('implement', 'PROJ-63');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('implementation: must list what you changed');
    const run = await app.get(RunRepository).findRun('PROJ-63');
    expect(run?.currentStep).toBe('implement');
    expect(run?.status).toBe('failed');
  });

  it('continues a rebase that has no conflicted files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-rebase-continue-'));
    await writeEnv(root);
    const tree = featureTree(root, 'PROJ-116', 'billing-api');
    const clone = join(root, 'billing-api');
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
    const base = git(tree, ['rev-parse', 'origin/main']);
    const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
    writeFileSync(isAbsolute(state) ? state : join(tree, state), `${base}\nfeat(PROJ-116): Ship the field\n`);
    writeFileSync(join(tree, 'src', 'note.ts'), 'short\nextra\n');
    git(tree, ['add', 'src/note.ts']);
    const savedTree = git(tree, ['write-tree']);
    const saved = git(tree, ['commit-tree', savedTree, '-m', 'swarmloop-rebase\nsrc/note.ts']);
    git(tree, ['update-ref', 'refs/worktree/swarmloop-rebase', saved]);
    git(tree, ['rm', '-f', '--cached', 'src/note.ts']);
    writeFileSync(join(tree, 'src', 'note.ts'), 'short\n');
    git(tree, ['add', 'src/note.ts']);
    git(clone, ['config', '--unset-all', 'user.email']);
    git(clone, ['config', '--unset-all', 'user.name']);
    const previousName = process.env.GIT_AUTHOR_NAME;
    const previousEmail = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_NAME = 'Ada Lovelace';
    process.env.GIT_AUTHOR_EMAIL = 'ada@example.com';
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-116', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-116');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-116');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.prompt).not.toContain('rebase --continue');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/PROJ-116-ship-the-field');
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(PROJ-116): Ship the field');
      expect(git(tree, ['log', '-1', '--format=%cn <%ce>'])).toBe('Ada Lovelace <ada@example.com>');
      expect(readFileSync(join(tree, 'src', 'note.ts'), 'utf8')).toContain('extra');
      expect(() => git(tree, ['rev-parse', '--verify', '--quiet', 'refs/worktree/swarmloop-rebase'])).toThrow();
    } finally {
      if (previousName === undefined) {
        delete process.env.GIT_AUTHOR_NAME;
      } else {
        process.env.GIT_AUTHOR_NAME = previousName;
      }
      if (previousEmail === undefined) {
        delete process.env.GIT_AUTHOR_EMAIL;
      } else {
        process.env.GIT_AUTHOR_EMAIL = previousEmail;
      }
      await app.close();
    }
  });

  it('names the conflicted files and stays on implement while the rebase is open', async () => {
    const tree = once.conflicted('PROJ-641', 'billing-api');
    let marked = '';
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes('The commit being replayed is')) {
        expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
        marked = readFileSync(join(tree, 'src', 'field.ts'), 'utf8');
        return result(rebaseReply);
      }
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    jest.spyOn(app.get(EnvironmentService), 'prepare').mockResolvedValue({
      launch: { image: 'test-image', cliVolume: 'test-cli', path: '/usr/bin', certFile: false, caches: [] },
      record: { repo: 'billing-api', config: { source: '.swarmloop.json', cache: [], checks: [] } },
    });
    jest.spyOn(app.get(EnvironmentService), 'check').mockResolvedValue({ passed: 0, total: 0 });
    await seed(app, 'PROJ-641', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-641');
    await documents.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-641');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-641'))?.agentCalls).toBe(2);
    const calls = agent.mock.calls.map((call) => call[0]);
    const input = calls[0];
    expect(input?.project?.image).toBe('test-image');
    expect(input?.prompt).toContain('# Project environment');
    expect(input?.resumeChatId ?? null).toBeNull();
    expect(input?.prompt).toContain('src/field.ts');
    expect(input?.prompt).toContain('The new base is origin/main.');
    expect(input?.prompt).toContain('The commit being replayed is');
    expect(input?.prompt).toContain('Ship the field');
    expect(input?.prompt).toContain('Edit only these files:');
    expect(input?.prompt).toContain('Do not run git.');
    expect(input?.prompt).not.toContain('rebase --continue');
    expect(input?.prompt).not.toContain('git add only those files');
    expect(input?.prompt).not.toContain('finish the checklist');
    expect(input?.prompt.toLowerCase()).not.toContain('ours');
    expect(input?.prompt.toLowerCase()).not.toContain('theirs');
    expect(calls[1]?.prompt).toContain('add the field');
    expect(calls[1]?.prompt).not.toContain('The commit being replayed is');
    expect(marked).toContain('<<<<<<<');
    expect(marked).toContain('>>>>>>>');
    expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe(marked);
    expect(git(tree, ['show', 'HEAD:src/field.ts'])).toBe(marked.trim());
    expect(git(tree, ['ls-files', '-u'])).not.toContain('src/field.ts');
    expect((await documents.latestBody('PROJ-641', REBASE_CONFLICT))?.trim()).toBe('review');
    expect((await runs.findRun('PROJ-641'))?.currentStep).toBe('implement-improve');
  });

  it('stages a resolved file and finishes the rebase without an agent', async () => {
    const tree = once.conflicted('PROJ-117', 'billing-api');
    const base = git(tree, ['rev-parse', 'HEAD']);
    const branch = 'feature/PROJ-117-ship-the-field';
    const rebaseMerge = git(tree, ['rev-parse', '--git-path', 'rebase-merge']);
    rmSync(isAbsolute(rebaseMerge) ? rebaseMerge : join(tree, rebaseMerge), { recursive: true, force: true });
    git(tree, ['update-ref', `refs/heads/${branch}`, base]);
    git(tree, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
    writeFileSync(isAbsolute(state) ? state : join(tree, state), `${base}\nfeat(PROJ-117): Ship the field\n`);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-117', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-117');
    await documents.putDocument(run!, 'implementation', '- changed the field parser\n');
    await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-117');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-117'))?.agentCalls).toBe(0);
    expect(git(tree, ['branch', '--show-current'])).toBe('feature/PROJ-117-ship-the-field');
    expect(git(tree, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
    expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe('export const field = 1;\n');
  });
});
