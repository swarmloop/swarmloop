import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { PassThrough } from 'stream';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_CONTINUE, AGENT_RUNNER, AgentRunInput, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { REBASE_CONFLICT, rebaseFeatureRepos } from '../../git/rebase-worktree';

const reply = ['implementation:', '- changed the field parser', '- ran unit tests', '', 'summary:', '- changed the parser so empty fields stay'].join('\n');

describe('implement step', () => {
  it('writes the checklist on the feature branch and waits for review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-60', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
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
      const notes = await documents.find({ where: { kind: 'implementation' } });
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toBe('- changed the field parser\n- ran unit tests\n');
      const handoff = await documents.find({ where: { kind: 'handoff' } });
      expect(handoff[0]?.body).toContain('## implement');
      expect(handoff[0]?.body).toContain('empty fields stay');
      const run = await app.get(HistoryService).findRun('PROJ-60');
      expect(run?.currentStep).toBe('implement-improve');
      expect(run?.status).toBe('waiting');
      expect(git(worktree, ['status', '--porcelain'])).toBe('');
      await app.get(PipelineService).step('implement', 'PROJ-60');
      expect(await documents.find({ where: { kind: 'implementation' } })).toHaveLength(1);
      expect((await app.get(HistoryService).findRun('PROJ-60'))?.currentStep).toBe('implement-improve');
    } finally {
      await app.close();
    }
  });

  it('continues the implement chat with a short prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-resume-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-69', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-69-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-69', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-69');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('plan-chat');
      expect(input.prompt).toContain('Read a file before editing it');
      expect(input.prompt).toContain('add the field');
      expect(input.prompt).not.toContain('# Implement');
      expect(input.prompt).not.toContain('Ship the field');
      expect(input.prompt).not.toContain('Package registries');
      expect(input.prompt).not.toContain('What previous steps did');
    } finally {
      await app.close();
    }
  });

  it('starts a fresh chat when only the plan session remains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-old-session-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-68', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-68-plan-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'plan-chat', resumed: true, completed: true, killReason: null, usd: 1.2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-68', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-68');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId ?? null).toBeNull();
      expect(input.prompt).toContain('# Implement');
      expect(input.prompt).toContain('Ship the field');
      expect(input.prompt).toContain('Package registries');
    } finally {
      await app.close();
    }
  });

  it('fails when the agent commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-commit-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-66', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      git(worktree, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'nope']);
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-66', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-66');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('billing-api was committed');
      const run = await app.get(HistoryService).findRun('PROJ-66');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('does not start the agent when the plan is not approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-61', 'billing-api');
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-61', 'revise');
      const done = await app.get(PipelineService).step('implement', 'PROJ-61');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('plan is not approved');
      expect(agent).not.toHaveBeenCalled();
      const run = await app.get(HistoryService).findRun('PROJ-61');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('does not start the agent when the plan body is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-empty-plan-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-64', 'billing-api');
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-64', null);
      const done = await app.get(PipelineService).step('implement', 'PROJ-64');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('plan is missing');
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not start the agent when the worktree is not a git checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-not-git-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-65', 'billing-api'), { recursive: true });
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-65', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-65');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('billing-api branch failed');
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not start the agent when the feature branch is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-branch-'));
    await writeEnv(root);
    detachedTree(root, 'PROJ-62', 'billing-api');
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-62', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-62');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('billing-api branch is missing');
      expect(agent).not.toHaveBeenCalled();
      expect((await app.get(HistoryService).findRun('PROJ-62'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('runs one agent for every worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-multi-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-67', 'api');
    featureTree(root, 'PROJ-67', 'web');
    const agent = jest.fn().mockResolvedValue(
      result('implementation:\n- api field\n- web button\n\nsummary:\n- both follow the plan\n'),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-67', 'approve', 'api\nweb\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-67');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/api', '/work/web']);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const notes = await documents.find({ where: { kind: 'implementation' } });
      expect(notes[0]?.body).toContain('- api field');
      expect(notes[0]?.body).toContain('- web button');
    } finally {
      await app.close();
    }
  });

  it('puts why it returned into the agent prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-return-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-68', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-68', 'approve');
      const run = await app.get(HistoryService).findRun('PROJ-68');
      await app.get(HistoryService).putDocument(run!, 'review_quality', 'use theme.alpha\ndecision: return\n');
      await app.get(HistoryService).putDocument(run!, 'handoff', '## plan\n- add the field\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-68');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.prompt).toContain('Why this returned:');
      expect(input.prompt).toContain('## quality');
      expect(input.prompt).toContain('use theme.alpha');
      expect(input.prompt).toContain('What previous steps did:');
      expect(input.prompt).toContain('## plan');
    } finally {
      await app.close();
    }
  });

  it('fails when the summary is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-summary-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-69', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('implementation:\n- changed the field parser\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-69', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-69');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('summary is missing');
    } finally {
      await app.close();
    }
  });

  it('fails when the implementation notes are empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-empty-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-63', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result('implementation:\n- none\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-63', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-63');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('implementation is empty');
      const run = await app.get(HistoryService).findRun('PROJ-63');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-116');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
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
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-conflict-'));
    await writeEnv(root);
    const tree = conflictedTree(root, 'PROJ-64', 'billing-api');
    let marked = '';
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes('The commit being replayed is')) {
        expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
        marked = readFileSync(join(tree, 'src', 'field.ts'), 'utf8');
        return result('edited the conflict\n');
      }
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-64', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-64');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-64');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      const input = calls[0];
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
      expect((await history.latestBody('PROJ-64', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await history.findRun('PROJ-64'))?.currentStep).toBe('implement-improve');
    } finally {
      await app.close();
    }
  });

  it('stages a resolved file and finishes the rebase without an agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-resolved-'));
    await writeEnv(root);
    const tree = conflictedTree(root, 'PROJ-117', 'billing-api');
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
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-117', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-117');
      await history.putDocument(run!, 'implementation', '- changed the field parser\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-117');
      expect(done.exitCode).toBe(0);
      expect(agent).not.toHaveBeenCalled();
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/PROJ-117-ship-the-field');
      expect(git(tree, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe('export const field = 1;\n');
    } finally {
      await app.close();
    }
  });

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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-118');
      await history.putDocument(run!, 'implementation', '- changed the field parser\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-118');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('pathspec');
      expect(agent).toHaveBeenCalledTimes(1);
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/overlap.ts');
      expect((await history.findRun('PROJ-118'))?.currentStep).toBe('code-review');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-65');
      await history.putDocument(run!, 'implementation', '- changed the field parser\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-65');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId ?? null).toBeNull();
      expect(input.prompt).toContain('The new base is origin/main.');
      expect(input.prompt).toContain('The commit being replayed is');
      expect(input.prompt).toContain('Ship the field');
      expect(input.prompt).not.toContain('rebase --continue');
      expect(input.prompt.toLowerCase()).not.toContain('ours');
      expect(input.prompt.toLowerCase()).not.toContain('theirs');
      const notes = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find({ where: { kind: 'implementation' } });
      expect(notes.map((item) => item.body)).toEqual(['- changed the field parser\n']);
      expect((await history.latestBody('PROJ-65', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await history.latestBody('PROJ-65', 'rebase_merge_skip'))?.trim()).toBe('skip');
      expect((await history.findRun('PROJ-65'))?.currentStep).toBe('code-review');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-168');
      await history.putDocument(run!, 'implementation', '- changed the field parser\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-168');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId ?? null).toBeNull();
      expect(input.prompt).toContain('The new base is origin/main.');
      expect(input.prompt).toContain('The commit being replayed is');
      expect(input.prompt).toContain('Ship the field');
      expect(input.prompt).not.toContain('rebase --continue');
      expect(input.prompt.toLowerCase()).not.toContain('ours');
      expect(input.prompt.toLowerCase()).not.toContain('theirs');
      const notes = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find({ where: { kind: 'implementation' } });
      expect(notes.map((item) => item.body)).toEqual(['- changed the field parser\n']);
      expect((await history.latestBody('PROJ-168', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await history.latestBody('PROJ-168', 'rebase_merge_skip'))?.trim()).toBe('skip');
      expect((await history.findRun('PROJ-168'))?.currentStep).toBe('code-review');
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
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
      });
      expect(stop.kind).toBe('conflict');
      const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
      expect(existsSync(isAbsolute(state) ? state : join(tree, state))).toBe(true);
      expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
      await seed(app, 'PROJ-169', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-169');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-169');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls[0]?.prompt).toContain('src/field.ts');
      expect(calls[0]?.prompt).toContain('The new base is origin/main.');
      expect(calls[0]?.prompt).toContain('The commit being replayed is');
      expect(calls[0]?.prompt).toContain('Ship the field');
      expect(calls[0]?.prompt).toContain('Do not run git.');
      expect(calls[1]?.prompt).toContain('add the field');
      expect(calls[1]?.prompt).not.toContain('The commit being replayed is');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe(marked);
      expect(git(tree, ['show', 'HEAD:src/field.ts'])).toBe(marked.trim());
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/field.ts');
      expect((await history.latestBody('PROJ-169', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await history.findRun('PROJ-169'))?.currentStep).toBe('implement-improve');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-66');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending-implement\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-66');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls[0]?.resumeChatId ?? null).toBeNull();
      expect(calls[0]?.prompt).toContain('The new base is origin/main.');
      expect(calls[1]?.prompt).toContain('add the field');
      expect(calls[1]?.prompt).not.toContain('The commit being replayed is');
      expect((await history.latestBody('PROJ-66', 'implementation'))?.trim()).toContain('changed the field parser');
      expect((await history.latestBody('PROJ-66', REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await history.findRun('PROJ-66'))?.currentStep).toBe('implement-improve');
      expect(() => git(tree, ['rev-parse', '--verify', 'refs/remotes/origin/feature/PROJ-66-ship-the-field'])).toThrow();
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-67');
      await history.putDocument(run!, 'implementation', '- changed the field parser\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'pending\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-67');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      git(other, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect((await history.findRun('PROJ-67'))?.currentStep).toBe('code-review');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-131');
      expect(run?.currentStep).toBe('implement-improve');
      expect(run?.agentCalls).toBe(2);
      const stats = await history.listStats(run?.id ?? 0);
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
        ['plan:', '- fix the failing test', '', 'implementation:', '- fixed the test', '', 'summary:', '- the pipeline log required it'].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-140', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-140');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-140');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      const record = JSON.parse((await history.latestBody('PROJ-140', 'requirements')) ?? '{}') as {
        prompt?: string;
        plan?: { items?: string[]; decision?: string };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.decision).toBe('approve');
      expect(record.prompt).toContain('Ship the field');
      const handoff = await history.latestBody('PROJ-140', 'handoff');
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
      const history = app.get(HistoryService);
      const record = JSON.parse((await history.latestBody('PROJ-141', 'requirements')) ?? '{}') as { plan?: { items?: string[] } };
      expect(record.plan?.items).toEqual(['add the field']);
      expect(await history.latestBody('PROJ-141', 'handoff')).not.toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('replaces the approved checklist when a pipeline return answers with the plan object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-json-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-145', 'billing-api');
    const plan = { name: 'Field', overview: 'Fix the failing test.', items: ['fix the failing test'], decision: 'approve' };
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        ['plan:', JSON.stringify(plan, null, 2), '', 'implementation:', '- fixed the test', '', 'summary:', '- the pipeline log required it'].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-145', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-145');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-145');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('plan is empty');
      expect(agent).toHaveBeenCalledTimes(1);
      const record = JSON.parse((await history.latestBody('PROJ-145', 'requirements')) ?? '{}') as {
        prompt?: string;
        plan?: { name?: string; items?: string[]; decision?: string };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.name).toBe('');
      expect(record.plan?.decision).toBe('approve');
      expect(record.prompt).toContain('Ship the field');
      const handoff = await history.latestBody('PROJ-145', 'handoff');
      expect(handoff).toContain('dropped "add the field"');
      expect(handoff).toContain('added "fix the failing test"');
      expect(handoff).toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('keeps the approved plan when the plan section has no checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-prose-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-146', 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(['plan:', 'The checklist stays.', '', reply].join('\n'));
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-146', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-146');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-146');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('plan is empty');
      const record = JSON.parse((await history.latestBody('PROJ-146', 'requirements')) ?? '{}') as { plan?: { items?: string[] } };
      expect(record.plan?.items).toEqual(['add the field']);
      expect(await history.latestBody('PROJ-146', 'handoff')).not.toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('saves the plan object from a later reply when the files were unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-json-later-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-147', 'billing-api');
    const plan = { name: 'Field', overview: 'Fix the failing test.', items: ['fix the failing test'], decision: 'approve' };
    let calls = 0;
    const agent = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return result(['implementation:', '- not yet', '', 'summary:', '- the log requires it'].join('\n'));
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        ['plan:', JSON.stringify(plan, null, 2), '', 'implementation:', '- fixed the test', '', 'summary:', '- the files now match the log'].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-147', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-147');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-147');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const record = JSON.parse((await history.latestBody('PROJ-147', 'requirements')) ?? '{}') as { plan?: { items?: string[] } };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(await history.latestBody('PROJ-147', 'implementation')).toContain('fixed the test');
      expect(await history.latestBody('PROJ-147', 'handoff')).toContain('added "fix the failing test"');
    } finally {
      await app.close();
    }
  });

  it('fails when a pipeline return leaves the worktree unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-unchanged-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-142', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(
        join(root, 'data', 'PROJ-142-implement-session.json'),
        `${JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', resumed: true, completed: true, killReason: null, usd: 0 })}\n`,
      );
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-142', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-142');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL nest npm test\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-142');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('pipeline failure left unfixed');
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls[1]?.prompt).toContain('The pipeline failure still stands and the files are unchanged.');
      expect(calls[1]?.prompt).toContain('FAIL nest npm test');
      expect(calls[1]?.resumeChatId).toBe('impl-chat');
      const after = await history.findRun('PROJ-142');
      expect(after?.currentStep).toBe('implement');
      expect(after?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('keeps the corrected checklist from the first reply when the second changes the files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-second-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-143', 'billing-api');
    let calls = 0;
    const agent = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return result(['plan:', '- fix the failing test', '', 'implementation:', '- not yet', '', 'summary:', '- the log requires it'].join('\n'));
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(['implementation:', '- fixed the test', '', 'summary:', '- the files now match the log'].join('\n'));
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-143', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-143');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-143');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const record = JSON.parse((await history.latestBody('PROJ-143', 'requirements')) ?? '{}') as { plan?: { items?: string[] } };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(await history.latestBody('PROJ-143', 'implementation')).toContain('fixed the test');
      expect(await history.latestBody('PROJ-143', 'handoff')).toContain('dropped "add the field"');
    } finally {
      await app.close();
    }
  });

  it('stores the corrected checklist when a pipeline return stays unfixed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-unfixed-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-144', 'billing-api');
    const agent = jest.fn().mockResolvedValue(
      result(['plan:', '- fix the failing test', '', 'implementation:', '- not yet', '', 'summary:', '- the log requires it'].join('\n')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-144', 'approve');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-144');
      await history.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-144');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('pipeline failure left unfixed');
      const after = await history.findRun('PROJ-144');
      expect(after?.currentStep).toBe('implement');
      expect(after?.status).toBe('failed');
      const record = JSON.parse((await history.latestBody('PROJ-144', 'requirements')) ?? '{}') as { plan?: { items?: string[]; decision?: string } };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.decision).toBe('approve');
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

async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  decision: 'approve' | 'revise' | null,
  repos = 'billing-api\n',
): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'implement');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement';
  await history.saveRun(seeded);
  const plan = decision ? { name: '', overview: '', items: ['add the field'], decision } : null;
  await history.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key, summary: 'Ship the field' }], plan }, null, 2)}\n`,
  );
  await history.putDocument(seeded, 'repos', repos);
}

async function bootLive(root: string, spawn: jest.Mock): ReturnType<typeof boot> {
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

function scripted(chunks: string[]): jest.Mock {
  const pending = [...chunks];
  return jest.fn(async () => {
    const next = pending.shift();
    if (!next) {
      throw new Error('unexpected spawn');
    }
    return fakeChild([next], 0);
  });
}

function launchedPrompt(call: unknown[] | undefined): string {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  return command[command.length - 1] ?? '';
}

function resumeArg(call: unknown[] | undefined): string | null {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  const at = command.indexOf('--resume');
  return at < 0 ? null : (command[at + 1] ?? null);
}

function chatStream(chatId: string, note?: string): string {
  const noteLine = note ? `${JSON.stringify({ type: 'thinking', text: note })}\n` : '';
  return `${noteLine}${JSON.stringify({ session_id: chatId })}\n`;
}

function doneStream(text: string): string {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

function fakeChild(chunks: string[], code: number): EventEmitter {
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

async function writeEnv(root: string, implementTimeout = 1800000): Promise<void> {
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

function conflictedTree(root: string, key: string, repo: string): string {
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

function featureTree(root: string, key: string, repo: string): string {
  const clone = repoWithMain(root, repo);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, worktree, 'origin/main']);
  return worktree;
}

function detachedTree(root: string, key: string, repo: string): string {
  const clone = repoWithMain(root, repo);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '--detach', worktree, 'origin/main']);
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
