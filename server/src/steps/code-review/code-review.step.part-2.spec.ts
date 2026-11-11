import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdirSync, realpathSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { DocumentEntity, LoopEventEntity } from '../../history/entities';

import { putStamped } from '../shared/gate.spec-helpers';
import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { VisitRepository } from '../../history/visit.repository';

import { FlowRepository } from '../../history/flow.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { ARTIFACTS } from '../contract/artifacts';
import { reviewContinue } from './code-review.prompts';

import { REBASE_CONFLICT } from '../../git/rebase';

import {
  REFUSED_WRITE,
  reply,
  result,
  boot,
  seed,
  bootLive,
  reviewSpawn,
  launches,
  launchedPrompt,
  resumeArg,
  writeEnv,
  repoWithBranch,
  git,
} from './code-review.step.spec-helpers';

describe('code-review step', () => {
  it('continues when the last open reviewer passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-last-ok-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-90', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-90');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-90');
      for (const name of ['requirements', 'regressions', 'security', 'performance']) {
        await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-90', { reviewer: 'quality' });
      expect(done.exitCode).toBe(0);
      expect((await runs.findRun('PROJ-90'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('returns to implement when the last open reviewer fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-last-return-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-91', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'return')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-91');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-91');
      for (const name of ['requirements', 'regressions', 'security', 'performance']) {
        await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-91', { reviewer: 'quality' });
      expect(done.exitCode).toBe(0);
      const next = await runs.findRun('PROJ-91');
      expect(next?.currentStep).toBe('implement');
      expect(next?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('stores one issue per returning reviewer next to the return document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-issues-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-92', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'return')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-92');
      const documents = app.get(DocumentRepository);
      const run = await app.get(RunRepository).findRun('PROJ-92');
      for (const name of ['requirements', 'regressions', 'security', 'performance']) {
        await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
      }
      await app.get(PipelineService).step('code-review', 'PROJ-92', { reviewer: 'quality' });
      const issues = ARTIFACTS.issues.parse((await documents.latestBody('PROJ-92', 'issues')) ?? '[]');
      expect(issues.map((issue) => issue.source)).toEqual(['quality']);
      expect(issues[0]?.id).toMatch(/^quality-[0-9a-f]{10}$/);
      expect(await documents.latestBody('PROJ-92', 'return')).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('reviews a checkout path without returning to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-path-'));
    const checkout = join(root, 'worktrees', 'checkout');
    mkdirSync(checkout, { recursive: true });
    await writeEnv(root);
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'return')));
    const app = await boot(root, agent);
    try {
      const done = await app.get(PipelineService).step('code-review', 'PROJ-85', { path: checkout });
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(
        calls.every((call) => call.mounts[0]?.containerPath === '/work' && call.mounts[0]?.readonly === true),
      ).toBe(true);
      const run = await app.get(RunRepository).findRun('PROJ-85');
      expect(run?.currentStep).toBe('commit');
      expect(run?.attemptsReview).toBe(0);
      expect(run?.targetPath).toBe(realpathSync(checkout));
      const loops = app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity));
      expect(await loops.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('refuses a checkout path outside the repositories and starts no reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-outside-'));
    const outside = await mkdtemp(join(tmpdir(), 'swarmloop-checkout-outside-'));
    await writeEnv(root);
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'return')));
    const app = await boot(root, agent);
    try {
      const refused = await app.get(PipelineService).step('code-review', 'PROJ-87', { path: outside });
      expect(refused.exitCode).toBe(1);
      expect(refused.message).toContain('path is outside the repositories');
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resumes a checkout review from the stored path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-resume-'));
    const checkout = join(root, 'worktrees', 'checkout');
    mkdirSync(checkout, { recursive: true });
    await writeEnv(root);
    let quality = 'notes\n';
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('quality') ? quality : reply(input.step, 'ok')),
    );
    const app = await boot(root, agent);
    try {
      const failed = await app.get(PipelineService).step('code-review', 'PROJ-86', { path: checkout });
      expect(failed.exitCode).toBe(1);
      expect(failed.message).toContain('decision is missing');
      quality = reply('quality', 'return');
      agent.mockClear();
      const done = await app.get(PipelineService).step('code-review', 'PROJ-86');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('implementation is missing');
      expect(agent).toHaveBeenCalledTimes(2);
      const call = agent.mock.calls[0]?.[0];
      expect(call.step).toBe('code-review-quality');
      expect(agent.mock.calls[1]?.[0]?.step).toBe('code-review-report');
      expect(call.mounts[0]?.hostPath).toBe(realpathSync(checkout));
      const run = await app.get(RunRepository).findRun('PROJ-86');
      expect(run?.currentStep).toBe('commit');
      expect(run?.attemptsReview).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('passes the previous handoff and return to every reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-handoff-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-87', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(`notes\n\ndecision: ok\n`, input.step));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-87');
      const run = await app.get(RunRepository).findRun('PROJ-87');
      await app
        .get(DocumentRepository)
        .putDocument(
          run!,
          'handoff',
          '## implement\n- changed the parser\n\n## implement-improve\n- kept the parser\n',
        );
      await app.get(DocumentRepository).putDocument(run!, 'return', '## quality\nuse theme.alpha\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-87');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      const reviewers = calls.filter((call) => call.step !== 'code-review-report');
      expect(reviewers).toHaveLength(5);
      expect(calls.find((call) => call.step === 'code-review-report')?.prompt).toContain('five decisions copied below');
      expect(reviewers[0]?.prompt).toContain('What previous steps did:');
      expect(reviewers[0]?.prompt).toContain('kept the parser');
      expect(reviewers[0]?.prompt).toContain('Why this returned:');
      expect(reviewers[0]?.prompt).toContain('use theme.alpha');
      const quality = reviewers.find((call) => call.step === 'code-review-quality');
      expect(quality?.prompt).toContain('Check clarity');
      expect(quality?.prompt).toContain(
        'A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return.',
      );
      expect(quality?.prompt).toContain('kept the parser');
      expect(quality?.prompt).toContain('/work/brief/diff.md');
      expect(quality?.mode).toBe('ask');
      const handoff = await app.get(DocumentRepository).latestBody('PROJ-87', 'handoff');
      expect(handoff).toContain('## implement');
      expect(handoff).toContain('## implement-improve');
      expect(handoff).toContain('## quality');
      expect(handoff).toContain('## requirements');
    } finally {
      await app.close();
    }
  });

  it('gives the reviewers of a split run the contract and the subtasks, and asks only the requirements reviewer for the proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-split-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-91', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(`notes\n\ndecision: ok\n`, input.step));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-91');
      const run = await app.get(RunRepository).findRun('PROJ-91');
      run!.split = true;
      await app.get(RunRepository).saveRun(run!);
      const documents = app.get(DocumentRepository);
      await documents.putDocument(run!, 'contract', 'decisions:\n- subtask a: store UTC\n');
      await documents.putDocument(
        run!,
        'subtasks',
        JSON.stringify([
          {
            id: 'a',
            title: 'Add the column',
            description: 'Adds it.',
            files: ['a.ts'],
            proof: 'a.spec.ts',
            status: 'merged',
          },
        ]),
      );
      const done = await app.get(PipelineService).step('code-review', 'PROJ-91');
      expect(done.exitCode).toBe(0);
      const reviewers = agent.mock.calls
        .map((call) => call[0])
        .filter((call) => call.step.startsWith('code-review-') && call.step !== 'code-review-report');
      expect(reviewers).toHaveLength(5);
      for (const call of reviewers) {
        expect(call.prompt).toContain('Contract:\ndecisions:\n- subtask a: store UTC');
        expect(call.prompt).toContain('Subtasks:');
        expect(call.prompt).toContain('- Add the column\n  changed: Adds it.\n  files: a.ts');
      }
      const proofCheck = reviewers.filter((call) => call.prompt.includes("Check every task's proof"));
      expect(proofCheck.map((call) => call.step)).toEqual(['code-review-requirements']);
    } finally {
      await app.close();
    }
  });

  it('adds no contract or subtasks section to the reviewers of a run that does not split', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-single-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-92', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(`notes\n\ndecision: ok\n`, input.step));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-92');
      await app.get(PipelineService).step('code-review', 'PROJ-92');
      for (const call of agent.mock.calls.map((item) => item[0])) {
        expect(call.prompt).not.toContain('Subtasks:');
        expect(call.prompt).not.toContain('Contract:');
      }
    } finally {
      await app.close();
    }
  });

  it('resumes the review chat with the full assignment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-session-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-86', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-86-code-review-quality-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'quality-chat', resumed: true, completed: true, killReason: null, usd: 3 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) => result(`notes\n\ndecision: ok\n`, input.step));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-86');
      const run = await app.get(RunRepository).findRun('PROJ-86');
      await app.get(DocumentRepository).putDocument(run!, 'implementation', '- checked the parser\n');
      await app
        .get(DocumentRepository)
        .putDocument(
          run!,
          'handoff',
          '## implement\n- the parser had to match the field\n\n## implement-improve\n- the first pass already did\n',
        );
      const done = await app.get(PipelineService).step('code-review', 'PROJ-86');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      const first = calls.find((call) => call.step === 'code-review-requirements');
      expect(first?.resumeChatId ?? null).toBeNull();
      expect(first?.prompt).toContain('Ship the field');
      expect(first?.prompt).not.toContain('quality-chat');
      const second = calls.find((call) => call.step === 'code-review-quality');
      expect(second?.resumeChatId).toBe('quality-chat');
      expect(second?.prompt).toContain('This chat is only the quality angle');
      expect(second?.prompt).toContain('What was done:\n- changed the field parser');
      expect(second?.prompt).toContain('What was done:\n- checked the parser');
      expect(second?.prompt).toContain('Why:\n- the parser had to match the field');
      expect(second?.prompt).toContain('Why:\n- the first pass already did');
      expect(second?.prompt).toContain('/work/brief/diff.md');
    } finally {
      await app.close();
    }
  });

  it('starts a fresh review after a conflict rebase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-fresh-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-97', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-97-code-review-quality-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'quality-chat', resumed: true, completed: true, killReason: null, usd: 3 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, 'ok'), input.step),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-97');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-97');
      run!.currentStep = 'code-review';
      run!.status = 'failed';
      await runs.saveRun(run!);
      await putStamped(app, run!, 'review_quality', 'notes\n\ndecision: ok\n', ['billing-api']);
      await documents.putDocument(run!, REBASE_CONFLICT, 'review\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-97');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      const reviewers = calls.filter((call) => call.step !== 'code-review-report');
      expect(reviewers.map((call) => call.step).sort()).toEqual(
        ['requirements', 'quality', 'regressions', 'security', 'performance']
          .map((name) => `code-review-${name}`)
          .sort(),
      );
      const quality = reviewers.find((call) => call.step === 'code-review-quality');
      expect(quality?.resumeChatId ?? null).toBeNull();
      expect((await runs.findRun('PROJ-97'))?.attemptsReview).toBe(0);
      expect(quality?.prompt).not.toContain('This chat is only the quality angle');
      expect(quality?.prompt).toContain('/work/brief/diff.md');
      expect((await documents.latestBody('PROJ-97', REBASE_CONFLICT))?.trim()).toBe('clear');
    } finally {
      await app.close();
    }
  });

  it('reviews a prompt branch read-only when implementation is off', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-foreign-'));
    const root = join(parent, 'swarm');
    mkdirSync(root);
    const clone = repoWithBranch(parent, 'app');
    await writeEnv(root, parent);
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const flows = app.get(FlowRepository);
      const seeded = await runs.begin('PROJ-88', 'code-review');
      seeded.status = 'waiting';
      seeded.currentStep = 'requirements';
      seeded.ownerPid = null;
      seeded.projects = 'app\n';
      seeded.prompt = 'https://example/browse/PROJ-88\nbranch: feature/other\n';
      await runs.saveRun(seeded);
      await flows.noteFlow('PROJ-88', ['planning', 'code-review'], null);
      await documents.putDocument(seeded, 'requirements', '{}\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-88');
      expect(done.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-88', 'app');
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls).toHaveLength(6);
      expect(
        calls.every(
          (call) =>
            call.mounts[0]?.readonly === true && realpathSync(call.mounts[0].hostPath) === realpathSync(worktree),
        ),
      ).toBe(true);
      expect(calls[0]?.prompt).toContain('Clean worktree');
      // The prompt branch is the base now, so a worktree that sits on it has no commits of its own to show.
      expect(calls[0]?.prompt).toContain('origin/feature/other');
      expect(calls[0]?.prompt).not.toContain('NEXT');
      expect(calls[0]?.prompt).not.toContain('local.txt');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/feature/other']));
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      const run = await runs.findRun('PROJ-88');
      expect(run?.attemptsReview).toBe(0);
      expect(run?.currentStep).toBe('done');
      expect(run?.targetPath ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reviews origin/main when a review-only prompt has no branch line', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-default-'));
    const root = join(parent, 'swarm');
    mkdirSync(root);
    const clone = repoWithBranch(parent, 'app');
    await writeEnv(root, parent);
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      const runs = app.get(RunRepository);
      const flows = app.get(FlowRepository);
      const seeded = await runs.begin('PROJ-89', 'code-review');
      seeded.status = 'waiting';
      seeded.currentStep = 'requirements';
      seeded.ownerPid = null;
      seeded.projects = 'app\n';
      seeded.prompt = 'Review the checkout\n';
      await runs.saveRun(seeded);
      await flows.noteFlow('PROJ-89', ['code-review'], null);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-89');
      expect(done.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-89', 'app');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      expect((await runs.findRun('PROJ-89'))?.attemptsReview).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('tries a timed-out reviewer three times and then continues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-time-'));
    await writeEnv(root, undefined, 3, 0);
    mkdirSync(join(root, 'worktrees', 'PROJ-95', 'billing-api'), { recursive: true });
    const spawn = reviewSpawn(3);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, 'PROJ-95');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-95');
      expect(done.exitCode).toBe(0);
      const securityCalls = launches(spawn, 'code-review-security');
      expect(securityCalls).toHaveLength(3);
      expect(resumeArg(securityCalls[1])).toBe('security-chat');
      expect(launchedPrompt(securityCalls[1])).toBe(reviewContinue('security'));
      expect(launchedPrompt(securityCalls[2])).toBe(reviewContinue('security'));
      expect(launches(spawn, 'code-review-quality')).toHaveLength(1);
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await runs.findRun('PROJ-95');
      expect(run?.currentStep).toBe('commit');
      const stats = await visits.listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'code-review-security')).toHaveLength(1);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect(await documents.find({ where: { kind: 'log' } })).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('stops a reviewer after the third time kill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-time-stop-'));
    await writeEnv(root, undefined, 3, 0);
    mkdirSync(join(root, 'worktrees', 'PROJ-96', 'billing-api'), { recursive: true });
    const spawn = reviewSpawn(0);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, 'PROJ-96');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-96');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(launches(spawn, 'code-review-security')).toHaveLength(3);
      const run = await app.get(RunRepository).findRun('PROJ-96');
      expect(run?.currentStep).toBe('code-review');
      const stats = await app.get(VisitRepository).listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'code-review-security')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('stops a reviewer after one time kill when the launch cap is 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-time-cap-'));
    await writeEnv(root, undefined, 1, 0);
    mkdirSync(join(root, 'worktrees', 'PROJ-101', 'billing-api'), { recursive: true });
    const spawn = reviewSpawn(0);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, 'PROJ-101');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-101');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(launches(spawn, 'code-review-security')).toHaveLength(1);
      expect((await app.get(RunRepository).findRun('PROJ-101'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('accepts a reviewer whose write was refused when its decision is ok', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-refused-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-82', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => ({
      ...result(
        input.step.endsWith('report') ? 'The parser change holds together.\n' : 'notes\n\ndecision: ok\n',
        input.step,
      ),
      output: input.step.endsWith('quality') ? REFUSED_WRITE : undefined,
    }));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-82');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-82');
      expect(done.exitCode).toBe(0);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect(await documents.count({ where: { kind: 'review_quality' } })).toBe(1);
      expect(await documents.count({ where: { kind: 'error' } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('names the refused write when a reviewer whose write was refused has no decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-no-decision-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-83', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => ({
      ...result(input.step.endsWith('quality') ? 'notes only\n' : reply(input.step, 'ok'), input.step),
      output: input.step.endsWith('quality') ? REFUSED_WRITE : undefined,
    }));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-83');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-83');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('decision is missing');
      expect(done.message).toContain('a write was refused: Cannot write to /work/billing-api/a.php');
    } finally {
      await app.close();
    }
  });
});
