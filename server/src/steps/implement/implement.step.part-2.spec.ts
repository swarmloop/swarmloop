import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import type { Repository } from 'typeorm';

import { DocumentEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { VisitRepository } from '../../history/visit.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { AGENT_CONTINUE } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { REBASE_CONFLICT, rebaseFeatureRepos } from '../../git/rebase';
import { memoryJournal } from '../../git/rebase/journal.spec-helpers';

import { FakeClock } from '../../core/fake-clock.spec-helpers';

import {
  reply,
  result,
  boot,
  seed,
  bootLive,
  scripted,
  launchedPrompt,
  resumeArg,
  chatStream,
  doneStream,
  writeEnv,
  conflictedTree,
  featureTree,
  git,
} from './implement.step.spec-helpers';

describe('implement step', () => {
  it('continues an empty resolution and leaves the base files in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-rebase-empty-'));
    await writeEnv(root);
    const tree = featureTree(root, 'PROJ-118', 'billing-api');
    const clone = join(root, 'billing-api');
    git(clone, ['config', 'user.email', 'dev@example.com']);
    git(clone, ['config', 'user.name', 'Dev']);
    mkdirSync(join(clone, 'src'), { recursive: true });
    writeFileSync(join(clone, 'src', 'own.ts'), 'export const own = 1;\n');
    writeFileSync(join(clone, 'src', 'kept.ts'), 'export const kept = 1;\n');
    writeFileSync(join(clone, 'src', 'gone.ts'), 'export const gone = 1;\n');
    writeFileSync(join(clone, 'src', 'overlap.ts'), 'export const overlap = 1;\n');
    writeFileSync(join(clone, 'src', 'base-edit.ts'), 'export const edited = 1;\n');
    git(clone, ['add', 'src']);
    git(clone, ['commit', '-m', 'start']);
    git(clone, ['push', 'origin', 'main']);
    git(tree, ['merge', '--ff-only', 'main']);
    writeFileSync(join(tree, 'src', 'own.ts'), 'export const own = 2;\n');
    writeFileSync(join(tree, 'src', 'kept.ts'), 'export const kept = 2;\n');
    git(tree, ['rm', 'src/gone.ts']);
    writeFileSync(join(tree, 'src', 'overlap.ts'), 'export const overlap = 3;\n');
    git(tree, ['add', 'src/own.ts', 'src/kept.ts', 'src/overlap.ts']);
    git(tree, ['commit', '-m', 'replay']);
    writeFileSync(join(clone, 'src', 'base-new.ts'), 'export const added = 1;\n');
    writeFileSync(join(clone, 'src', 'base-edit.ts'), 'export const edited = 2;\n');
    writeFileSync(join(clone, 'src', 'overlap.ts'), 'export const overlap = 2;\n');
    git(clone, ['add', 'src/base-new.ts', 'src/base-edit.ts', 'src/overlap.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    git(tree, ['fetch', 'origin', 'main']);
    try {
      git(tree, ['rebase', 'origin/main']);
    } catch {
      // overlap stops the rebase before the commit
    }
    writeFileSync(join(tree, 'src', 'overlap.ts'), 'export const overlap = 2;\n');
    git(tree, ['add', 'src/overlap.ts']);
    git(tree, ['checkout', 'HEAD', '--', 'src/own.ts', 'src/kept.ts', 'src/gone.ts']);
    expect(git(tree, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
    git(tree, ['diff', '--cached', '--quiet', 'HEAD']);
    const marker = git(tree, ['rev-parse', '--git-path', 'rebase-merge']);
    expect(existsSync(isAbsolute(marker) ? marker : join(tree, marker))).toBe(true);
    const agent = jest.fn(async () => {
      expect(git(tree, ['ls-files', '-u'])).toContain('src/overlap.ts');
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-118', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-118');
      await documents.putDocument(run!, 'implementation', '- changed the field parser\n');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-118');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('pathspec');
      expect(agent).toHaveBeenCalledTimes(1);
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/overlap.ts');
      expect((await runs.findRun('PROJ-118'))?.currentStep).toBe('checks');
    } finally {
      await app.close();
    }
  });

  it('returns the existing implementation text after the rebase completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-resolve-'));
    await writeEnv(root);
    const tree = conflictedTree(root, 'PROJ-65', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 3;\n');
      return result('implementation:\n- something else\n\nsummary:\n- resolved the rebase\n');
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-65', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-65');
      await documents.putDocument(run!, 'implementation', '- changed the field parser\n');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-65');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0];
      expect(input.resumeChatId ?? null).toBeNull();
      expect(input.prompt).toContain('The new base is origin/main.');
      expect(input.prompt).toContain('The commit being replayed is');
      expect(input.prompt).toContain('Ship the field');
      expect(input.prompt).not.toContain('rebase --continue');
      expect(input.prompt.toLowerCase()).not.toContain('ours');
      expect(input.prompt.toLowerCase()).not.toContain('theirs');
      const notes = await app
        .get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity))
        .find({ where: { kind: 'implementation' } });
      expect(notes.map((item) => item.body)).toEqual(['- changed the field parser\n']);
      expect((await documents.latestBody('PROJ-65', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await documents.latestBody('PROJ-65', 'rebase_merge_skip'))?.trim()).toBe('skip');
      expect((await runs.findRun('PROJ-65'))?.currentStep).toBe('checks');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/PROJ-65-ship-the-field');
      expect(git(tree, ['show', 'HEAD:src/field.ts'])).toContain('field = 3');
    } finally {
      await app.close();
    }
  });

  it('returns the existing implementation text when the resolution still contains conflict markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-marker-bytes-'));
    await writeEnv(root);
    const tree = conflictedTree(root, 'PROJ-168', 'billing-api');
    const marked = 'export const field = 3;\n<<<<<<<\n>>>>>>>\n';
    const agent = jest.fn(async (_input: AgentRunInput) => {
      expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
      writeFileSync(join(tree, 'src', 'field.ts'), marked);
      expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
      return result('implementation:\n- something else\n\nsummary:\n- resolved the rebase\n');
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-168', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-168');
      await documents.putDocument(run!, 'implementation', '- changed the field parser\n');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-168');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0];
      expect(input.resumeChatId ?? null).toBeNull();
      expect(input.prompt).toContain('The new base is origin/main.');
      expect(input.prompt).toContain('The commit being replayed is');
      expect(input.prompt).toContain('Ship the field');
      expect(input.prompt).not.toContain('rebase --continue');
      expect(input.prompt.toLowerCase()).not.toContain('ours');
      expect(input.prompt.toLowerCase()).not.toContain('theirs');
      const notes = await app
        .get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity))
        .find({ where: { kind: 'implementation' } });
      expect(notes.map((item) => item.body)).toEqual(['- changed the field parser\n']);
      expect((await documents.latestBody('PROJ-168', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await documents.latestBody('PROJ-168', 'rebase_merge_skip'))?.trim()).toBe('skip');
      expect((await runs.findRun('PROJ-168'))?.currentStep).toBe('checks');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/PROJ-168-ship-the-field');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe(marked);
      expect(git(tree, ['show', 'HEAD:src/field.ts'])).toBe(marked.trim());
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/field.ts');
    } finally {
      await app.close();
    }
  });

  it('shows a parked conflict to the agent before the commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-parked-'));
    await writeEnv(root);
    const tree = featureTree(root, 'PROJ-169', 'billing-api');
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
    const marked = 'export const field = 3;\n<<<<<<<\n>>>>>>>\n';
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes('The commit being replayed is')) {
        expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
        writeFileSync(join(tree, 'src', 'field.ts'), marked);
        expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
        return result('edited the conflict\n');
      }
      return result(reply);
    });
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    const app = await boot(root, agent);
    try {
      const stop = await rebaseFeatureRepos({
        root,
        key: 'PROJ-169',
        repos: ['billing-api'],
        branch: 'feature/PROJ-169-ship-the-field',
        prompt: null,
        denied: [],
        message: 'feat(PROJ-169): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop.kind).toBe('conflict');
      const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
      expect(existsSync(isAbsolute(state) ? state : join(tree, state))).toBe(true);
      expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
      await seed(app, 'PROJ-169', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-169');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      await documents.putDocument(run!, 'instructions:implement', 'Extract actual function bodies');
      const done = await app.get(PipelineService).step('implement', 'PROJ-169');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls[0]?.prompt).toContain('src/field.ts');
      expect(calls[0]?.prompt).toContain('The new base is origin/main.');
      expect(calls[0]?.prompt).toContain('The commit being replayed is');
      expect(calls[0]?.prompt).toContain('Ship the field');
      expect(calls[0]?.prompt).toContain('Do not run git.');
      expect(calls[0]?.prompt).not.toContain('Extract actual function bodies');
      expect(calls[1]?.prompt).toContain('add the field');
      expect(calls[1]?.prompt).toContain('Extract actual function bodies');
      expect(calls[1]?.prompt).not.toContain('The commit being replayed is');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe(marked);
      expect(git(tree, ['show', 'HEAD:src/field.ts'])).toBe(marked.trim());
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/field.ts');
      expect((await documents.latestBody('PROJ-169', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await runs.findRun('PROJ-169'))?.currentStep).toBe('implement-improve');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
      await app.close();
    }
  });

  it('finishes the checklist once the conflict rebase is clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-checklist-'));
    await writeEnv(root);
    const tree = conflictedTree(root, 'PROJ-66', 'billing-api');
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes('The commit being replayed is')) {
        writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 3;\n');
        return result('edited the conflict\n');
      }
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-66', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-66');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-66');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls[0]?.resumeChatId ?? null).toBeNull();
      expect(calls[0]?.prompt).toContain('The new base is origin/main.');
      expect(calls[1]?.prompt).toContain('add the field');
      expect(calls[1]?.prompt).not.toContain('The commit being replayed is');
      expect((await documents.latestBody('PROJ-66', 'implementation'))?.trim()).toContain('changed the field parser');
      expect((await documents.latestBody('PROJ-66', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await runs.findRun('PROJ-66'))?.currentStep).toBe('implement-improve');
      expect(() =>
        git(tree, ['rev-parse', '--verify', 'refs/remotes/origin/feature/PROJ-66-ship-the-field']),
      ).toThrow();
    } finally {
      await app.close();
    }
  });

  it('rebases a later repo after the conflict is resolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-later-'));
    await writeEnv(root);
    const first = conflictedTree(root, 'PROJ-67', 'billing-api');
    const other = featureTree(root, 'PROJ-67', 'other');
    const clone = join(root, 'other');
    git(clone, ['config', 'user.email', 'dev@example.com']);
    git(clone, ['config', 'user.name', 'Dev']);
    writeFileSync(join(other, 'extra.ts'), 'export const extra = 1;\n');
    git(other, ['add', 'extra.ts']);
    git(other, ['commit', '-m', 'extra']);
    writeFileSync(join(clone, 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const agent = jest.fn(async () => {
      writeFileSync(join(first, 'src', 'field.ts'), 'export const field = 3;\n');
      return result('edited the conflict\n');
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-67', 'approve', 'billing-api\nother\n');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-67');
      await documents.putDocument(run!, 'implementation', '- changed the field parser\n');
      await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-67');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      git(other, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect((await runs.findRun('PROJ-67'))?.currentStep).toBe('checks');
      expect(git(other, ['branch', '--show-current'])).toBe('feature/PROJ-67-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('finishes one implement visit after a time kill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-time-'));
    await writeEnv(root, 0);
    featureTree(root, 'PROJ-131', 'billing-api');
    const spawn = scripted([chatStream('impl-chat', 'partial'), doneStream(reply)]);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, 'PROJ-131', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-131');
      expect(done.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(launchedPrompt(spawn.mock.calls[1])).toBe(AGENT_CONTINUE);
      expect(resumeArg(spawn.mock.calls[1])).toBe('impl-chat');
      const runs = app.get(RunRepository);
      const visitRepository = app.get(VisitRepository);
      const run = await runs.findRun('PROJ-131');
      expect(run?.currentStep).toBe('implement-improve');
      expect(run?.agentCalls).toBe(2);
      const stats = await visitRepository.listStats(run?.id ?? 0);
      const visits = stats.filter((item) => item.step === 'implement');
      expect(visits).toHaveLength(1);
      expect(visits[0]?.status).toBe('done');
      expect(visits[0]?.killReason ?? null).toBeNull();
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' } });
      expect(notes[0]?.body).toContain('changed the field parser');
    } finally {
      await app.close();
    }
  });

  it('replaces the approved checklist when a pipeline return answers with a plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-fix-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-140', 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        [
          'plan:',
          '- fix the failing test',
          '',
          'implementation:',
          '- fixed the test',
          '',
          'summary:',
          '- the pipeline log required it',
        ].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-140', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-140');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-140');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const record = JSON.parse((await documents.latestBody('PROJ-140', 'requirements')) ?? '{}') as {
        prompt?: string;
        plan?: { items?: string[]; decision?: string };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.decision).toBe('approve');
      expect(record.prompt).toContain('Ship the field');
      const handoff = await documents.latestBody('PROJ-140', 'handoff');
      expect(handoff).toContain('dropped "add the field"');
      expect(handoff).toContain('added "fix the failing test"');
      expect(handoff).toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('leaves the approved plan when the answer has no plan section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-keep-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-141', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-141', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-141');
      expect(done.exitCode).toBe(0);
      const documents = app.get(DocumentRepository);
      const record = JSON.parse((await documents.latestBody('PROJ-141', 'requirements')) ?? '{}') as {
        plan?: { items?: string[] };
      };
      expect(record.plan?.items).toEqual(['add the field']);
      expect(await documents.latestBody('PROJ-141', 'handoff')).not.toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('handoff shows the cause only when the answer has one', async () => {
    const handoffFor = async (ticket: string, answer: string): Promise<string | null> => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-cause-'));
      await writeEnv(root);
      featureTree(root, ticket, 'billing-api');
      const app = await boot(root, jest.fn().mockResolvedValue(result(answer)));
      try {
        await seed(app, ticket, 'approve');
        await app.get(PipelineService).step('implement', ticket);
        return await app.get(DocumentRepository).latestBody(ticket, 'handoff');
      } finally {
        await app.close();
      }
    };
    const plain = await handoffFor('PROJ-150', reply);
    const withCause = await handoffFor('PROJ-151', `cause:\n- the parser dropped the suffix\n\n${reply}`);
    expect(plain).not.toContain('cause:');
    expect(withCause).toBe(
      plain?.replace('## implement\n', '## implement\ncause:\n- the parser dropped the suffix\n\n'),
    );
  });

  it('replaces the approved checklist when a pipeline return answers with the plan object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-json-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-145', 'billing-api');
    const plan = {
      name: 'Field',
      overview: 'Fix the failing test.',
      items: ['fix the failing test'],
      decision: 'approve',
    };
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        [
          'plan:',
          JSON.stringify(plan, null, 2),
          '',
          'implementation:',
          '- fixed the test',
          '',
          'summary:',
          '- the pipeline log required it',
        ].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-145', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-145');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-145');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('plan is empty');
      expect(agent).toHaveBeenCalledTimes(1);
      const record = JSON.parse((await documents.latestBody('PROJ-145', 'requirements')) ?? '{}') as {
        prompt?: string;
        plan?: { name?: string; items?: string[]; decision?: string };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.name).toBe('');
      expect(record.plan?.decision).toBe('approve');
      expect(record.prompt).toContain('Ship the field');
      const handoff = await documents.latestBody('PROJ-145', 'handoff');
      expect(handoff).toContain('dropped "add the field"');
      expect(handoff).toContain('added "fix the failing test"');
      expect(handoff).toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });
});
