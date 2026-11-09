import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdirSync, utimesSync, writeFileSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { AgentExchangeEntity, DocumentEntity, LoopEventEntity } from '../../history/entities';

import { putStamped } from '../shared/gate.spec-helpers';
import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { VisitRepository } from '../../history/visit.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { REPORT_CONTINUE, reviewContinue } from './code-review.prompts';

import { selectReviewers } from './review-round';
import { reply, result, boot, seed, writeEnv } from './code-review.step.spec-helpers';

describe('code-review step', () => {
  it('retries an empty review report with the targeted follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-report-retry-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-79', 'billing-api'), { recursive: true });
    let reports = 0;
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.step.endsWith('report')) {
        return result(reports++ === 0 ? '' : 'The review holds.\n', input.step);
      }
      return result('notes\n\ndecision: ok\n', input.step);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-79');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-79');
      const calls = agent.mock.calls.map((call) => call[0]);

      expect(done.exitCode).toBe(0);
      expect(calls.filter((call) => call.step === 'code-review-report')).toHaveLength(2);
      expect(calls.at(-1)?.prompt).toContain('missing the review report section');
      expect(calls.at(-1)?.prompt).toContain('## What holds\n\n## What to fix');
    } finally {
      await app.close();
    }
  });

  it('stores five reviews when every decision is ok', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-80', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report') ? 'The parser change holds together.\n' : 'notes\n\ndecision: ok\n',
        input.step,
      ),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-80');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-80');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('review_requirements ok');
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls.map((call) => call.step).sort()).toEqual([
        'code-review-performance',
        'code-review-quality',
        'code-review-regressions',
        'code-review-report',
        'code-review-requirements',
        'code-review-security',
      ]);
      const reportCall = calls.find((call) => call.step === 'code-review-report');
      expect(reportCall?.model).toBe('opus-5.5-extra-high');
      expect(reportCall?.mode).toBe('ask');
      expect(reportCall?.prompt).toContain('five decisions copied below');
      expect(reportCall?.resumeChatId ?? null).toBeNull();
      expect(reportCall?.continuePrompt).toBe(REPORT_CONTINUE);
      expect(calls.find((call) => call.step === 'code-review-security')?.continuePrompt).toBe(
        reviewContinue('security'),
      );
      expect(reportCall?.prompt).toContain('Those decisions are the only reviews');
      expect(reportCall?.prompt).toContain('## Quality');
      expect(reportCall?.prompt).toContain('decision: ok');
      expect(reportCall?.prompt).not.toContain('Diff:');
      expect(calls.find((call) => call.step === 'code-review-requirements')?.model).toBe('opus-5.5-extra-high');
      expect(calls.find((call) => call.step === 'code-review-security')?.model).toBe('opus-5.5-extra-high');
      expect(calls.find((call) => call.step === 'code-review-quality')?.model).toBe('opus-5.5-extra-high');
      expect(calls.find((call) => call.step === 'code-review-quality')?.prompt).toContain('Check clarity');
      expect(calls.find((call) => call.step === 'code-review-quality')?.prompt).toContain(
        'A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return.',
      );
      expect(calls.find((call) => call.step === 'code-review-quality')?.prompt).toContain('/work/brief/diff.md');
      expect(calls.find((call) => call.step === 'code-review-quality')?.prompt).toContain('Do not run tests');
      expect(calls.find((call) => call.step === 'code-review-quality')?.mode).toBe('ask');
      expect(calls.every((call) => call.liveStep === undefined)).toBe(true);
      expect(calls.every((call) => call.timeLimitMs === 15 * 60 * 1000)).toBe(true);
      expect(calls.every((call) => call.mounts.every((mount) => mount.readonly === true))).toBe(true);
      expect(calls[0]?.prompt).toContain('changed the field parser');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const reviews = await documents.find({ where: { kind: 'review_quality' } });
      expect(reviews).toHaveLength(1);
      expect(await documents.count({ where: { kind: 'review_requirements' } })).toBe(1);
      expect(await documents.count({ where: { kind: 'review_regressions' } })).toBe(1);
      expect(await documents.count({ where: { kind: 'review_security' } })).toBe(1);
      expect(await documents.count({ where: { kind: 'review_performance' } })).toBe(1);
      const report = await documents.findOne({ where: { kind: 'review_report' } });
      expect(report?.body).toBe('The parser change holds together.\n');
      const exchanges = app.get<Repository<AgentExchangeEntity>>(getRepositoryToken(AgentExchangeEntity));
      expect(await exchanges.count()).toBe(6);
      const run = await app.get(RunRepository).findRun('PROJ-80');
      expect(run?.currentStep).toBe('commit');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsReview).toBe(0);
      await app.get(PipelineService).step('code-review', 'PROJ-80');
      expect(await documents.count({ where: { kind: 'review_quality' } })).toBe(1);
      expect((await app.get(RunRepository).findRun('PROJ-80'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('puts the Impact section in every reviewer prompt and the report prompt, and leaves it out without a list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-impact-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-86', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-87', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'Holds.\n' : 'notes\n\ndecision: ok\n', input.step),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-86');
      await seed(app, 'PROJ-87');
      const run = await app.get(RunRepository).findRun('PROJ-87');
      await app.get(DocumentRepository).putDocument(run!, 'impact', '- live agent log | step-documents.tsx | kept\n');
      await app.get(PipelineService).step('code-review', 'PROJ-86');
      const before = agent.mock.calls.length;
      await app.get(PipelineService).step('code-review', 'PROJ-87');
      const plain = agent.mock.calls.slice(0, before).map((call) => call[0]);
      const listed = agent.mock.calls.slice(before).map((call) => call[0]);
      expect(plain).toHaveLength(6);
      expect(plain.some((call) => call.prompt.includes('\nImpact:\n'))).toBe(false);
      expect(listed).toHaveLength(6);
      for (const call of listed) {
        expect(call.prompt).toContain('\nImpact:\n- live agent log | step-documents.tsx | kept');
      }
    } finally {
      await app.close();
    }
  });

  it('runs the five reviewers together and writes the report after they finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-parallel-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-81', 'billing-api'), { recursive: true });
    let open = 0;
    let peak = 0;
    let releaseReviewers: (() => void) | undefined;
    const reviewersReady = new Promise<void>((resolve) => {
      releaseReviewers = resolve;
    });
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (!input.step.endsWith('report')) {
        open += 1;
        peak = Math.max(peak, open);
        if (open === 5) releaseReviewers?.();
        await reviewersReady;
        open -= 1;
      }
      return {
        ...result(
          input.step.endsWith('report') ? 'The parser change holds together.\n' : 'notes\n\ndecision: ok\n',
          input.step,
        ),
        samples: [{ sampledAt: new Date().toISOString(), cpuPercent: 22, rssBytes: 4096 }],
      };
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-81');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-81');
      expect(done.exitCode).toBe(0);
      expect(peak).toBe(5);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls.at(-1)?.step).toBe('code-review-report');
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await runs.findRun('PROJ-81');
      const stats = await visits.listStats(run!.id);
      const quality = stats.find((stat) => stat.step === 'code-review-quality');
      expect(quality?.cpuPeak).toBe(22);
      expect(quality?.status).toBe('done');
      const report = stats.find((stat) => stat.step === 'code-review');
      expect(report?.tokensIn).toBe(10);
      expect(report?.mode).toBe('ask');
      const reportSamples = await visits.listSamples(report ? [report.id] : []);
      expect(reportSamples).toHaveLength(1);
      expect(quality?.tokensIn).toBe(10);
    } finally {
      await app.close();
    }
  });

  it('returns to implement while attempts_review is below the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-return-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-81', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? 'Quality found one parser bug. The other checks describe that same bug.\n\nWhat to fix:\n- Keep the empty segment.\n'
          : reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok'),
        input.step,
      ),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-81');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-81');
      expect(done.exitCode).toBe(0);
      const run = await app.get(RunRepository).findRun('PROJ-81');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsReview).toBe(1);
      const loops = app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity));
      const events = await loops.find();
      expect(events).toHaveLength(1);
      expect(events[0]?.counter).toBe('review');
      expect(events[0]?.attempt).toBe(1);
      expect(events[0]?.reason).toBe('review_quality');
      const notes = await app.get(DocumentRepository).latestBody('PROJ-81', 'return');
      expect(notes).toContain('What to fix:');
      expect(notes).toContain('Keep the empty segment.');
      expect(notes).not.toContain('decision: return');
      const report = await app.get(DocumentRepository).latestBody('PROJ-81', 'review_report');
      expect(report).toContain('What to fix:');
      expect(report).toContain('Keep the empty segment.');
      expect(report).not.toContain('decision: return');
    } finally {
      await app.close();
    }
  });

  it('still returns to implement when the prompt names a branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-own-branch-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-93', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-93');
      const runs = app.get(RunRepository);
      const seeded = await runs.findRun('PROJ-93');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.prompt = 'branch: feature/other\n';
      await runs.saveRun(seeded);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-93');
      expect(done.exitCode).toBe(0);
      const run = await runs.findRun('PROJ-93');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsReview).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('finishes a review return even when attempts_review is already at the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-stop-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-82', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-82', 3);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-82');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('waiting');
      const run = await app.get(RunRepository).findRun('PROJ-82');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsReview).toBe(4);
      expect(agent).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('recovers a backticked decision from the log on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-recover-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-87', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    await writeFile(
      join(root, 'data', 'PROJ-87-code-review-performance-output.txt'),
      `${JSON.stringify({ type: 'result', result: 'notes\n`decision: ok`\n' })}\nprocess exited 0\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) => result('The five checks agree.\n', input.step));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-87');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-87');
      run!.status = 'failed';
      run!.currentStep = 'code-review';
      await runs.saveRun(run!);
      for (const name of ['requirements', 'quality', 'regressions', 'security']) {
        await putStamped(app, run!, `review_${name}`, `notes\ndecision: ok\n`, ['billing-api']);
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-87');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      expect(agent.mock.calls[0]?.[0]?.step).toBe('code-review-report');
      expect((await runs.findRun('PROJ-87'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('keeps finished reviewers and starts only the one that failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-retry-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-83', 'billing-api'), { recursive: true });
    let quality = 'notes\n';
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('quality') ? quality : reply(input.step, 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-83');
      const failed = await app.get(PipelineService).step('code-review', 'PROJ-83');
      expect(failed.exitCode).toBe(1);
      expect(failed.message).toContain('decision is missing');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect(await documents.count({ where: { kind: 'review_quality' } })).toBe(0);
      expect(await documents.count({ where: { kind: 'review_security' } })).toBe(1);
      expect((await app.get(RunRepository).findRun('PROJ-83'))?.currentStep).toBe('code-review');
      quality = reply('quality', 'ok');
      agent.mockClear();
      const done = await app.get(PipelineService).step('code-review', 'PROJ-83');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      expect(agent.mock.calls[0]?.[0]?.step).toBe('code-review-quality');
      expect(agent.mock.calls[1]?.[0]?.step).toBe('code-review-report');
      expect((await app.get(RunRepository).findRun('PROJ-83'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('does not start when the remaining call ceiling cannot cover every reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-fit-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-84', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-84', 0, 15);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-84', { auto: true });
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('code-review does not fit');
      expect(agent).not.toHaveBeenCalled();
      const run = await app.get(RunRepository).findRun('PROJ-84');
      expect(run?.status).toBe('failed');
      expect(run?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('keeps an unchanged approved diff when a new fan-out does not fit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-same-fit-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-100', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-100');
      const runs = app.get(RunRepository);
      const first = await app.get(PipelineService).step('code-review', 'PROJ-100');
      expect(first.exitCode).toBe(0);
      const run = await runs.findRun('PROJ-100');
      if (!run) {
        throw new Error('run is missing');
      }
      run.agentCalls = 15;
      run.status = 'waiting';
      run.currentStep = 'code-review';
      await runs.saveRun(run);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-100', { auto: true });
      expect(second.exitCode).toBe(0);
      expect(second.message).not.toContain('does not fit');
      expect(agent.mock.calls.map((call) => call[0].step)).toEqual(['code-review-report']);
      expect((await runs.findRun('PROJ-100'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('reuses stored reviews when Run again left a failed visit waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-replay-fit-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-88', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(reply(input.step, input.step.endsWith('quality') || input.step.endsWith('regressions') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-88', 1, 17);
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await runs.findRun('PROJ-88');
      run!.status = 'waiting';
      run!.currentStep = 'code-review';
      await runs.saveRun(run!);
      const now = new Date().toISOString();
      await visits.finishVisit(run!, {
        step: 'code-review',
        model: null,
        mode: null,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'blocked',
        exitCode: 1,
        killReason: null,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        samples: [],
        exchange: null,
        httpCalls: [],
        document: { kind: 'error', fileName: '', body: 'code-review does not fit\n' },
        resumed: false,
      });
      for (const name of ['requirements', 'security', 'performance']) {
        await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
      }
      await putStamped(app, run!, 'review_quality', 'theme.alpha\ndecision: return\n', ['billing-api']);
      await putStamped(app, run!, 'review_regressions', 'statusColor\ndecision: return\n', ['billing-api']);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-88');
      expect(done.message).not.toContain('does not fit');
      expect(agent.mock.calls.map((call) => call[0].step).sort()).toEqual(['code-review-report']);
      const next = await runs.findRun('PROJ-88');
      expect(next?.currentStep).toBe('implement');
      expect(next?.status).toBe('waiting');
      expect(next?.attemptsReview).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('continues an interrupted reviewer and keeps a finished return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-continue-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-94', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-94-code-review-security-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'security-chat', resumed: false, completed: false, killReason: 'time', usd: 1 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The checks are in.\n' : 'notes\ndecision: ok\n', input.step),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-94');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-94');
      run!.status = 'failed';
      run!.currentStep = 'code-review';
      await runs.saveRun(run!);
      await putStamped(app, run!, 'review_requirements', 'notes\ndecision: return\n', ['billing-api']);
      for (const name of ['quality', 'regressions', 'performance']) {
        await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-94');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls.map((call) => call.step)).toEqual(['code-review-security', 'code-review-report']);
      expect(calls[0]?.resumeChatId).toBe('security-chat');
      expect(calls[0]?.prompt).toContain('You were interrupted before the decision');
      expect(calls[0]?.prompt).not.toContain('Implement and implement-improve have run');
      expect((await runs.findRun('PROJ-94'))?.currentStep).toBe('implement');
    } finally {
      await app.close();
    }
  });

  it('keeps other open reviewers when one is started alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-one-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-89', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-89');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-89');
      await putStamped(app, run!, 'review_requirements', 'notes\ndecision: ok\n', ['billing-api']);
      await putStamped(app, run!, 'review_security', 'notes\ndecision: ok\n', ['billing-api']);
      await putStamped(app, run!, 'review_performance', 'notes\ndecision: ok\n', ['billing-api']);
      await putStamped(app, run!, 'review_regressions', 'notes\ndecision: return\n', ['billing-api']);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-89', { reviewer: 'quality' });
      expect(agent).toHaveBeenCalledTimes(1);
      expect(agent.mock.calls[0]?.[0]?.step).toBe('code-review-quality');
      expect(done.exitCode).toBe(0);
      const next = await runs.findRun('PROJ-89');
      expect(next?.currentStep).toBe('code-review');
      expect(next?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('does not recover an ok from a reviewer file of an older round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-older-round-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const finished = (text: string): string =>
      `${JSON.stringify({ type: 'result', result: text })}\nprocess exited 0\n`;
    // Ids sort opposite to age: round 1 is 'zzz' and says ok, round 2 is 'aaa' and says return.
    const older = join(root, 'data', 'PROJ-88-code-review-quality-zzz-output.txt');
    const newer = join(root, 'data', 'PROJ-88-code-review-quality-aaa-output.txt');
    writeFileSync(older, finished('notes\ndecision: ok\n'));
    writeFileSync(newer, finished('notes\ndecision: return\n'));
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    const documents = { latestBody: async () => null } as unknown as DocumentRepository;
    const input = { key: 'PROJ-88', only: undefined, fresh: false, retry: true, same: false, repeated: false };
    const counts = async (): Promise<boolean> => false;
    const second = await selectReviewers(documents, root, { ...input, attemptId: 'aaa', counts });
    expect(second.kept.find((item) => item.kind === 'review_quality')?.decision).toBe('return');
    const missing = await selectReviewers(documents, root, { ...input, attemptId: 'missing', counts });
    expect(missing.kept.find((item) => item.kind === 'review_quality')).toBeUndefined();
    expect(missing.pending.some((reviewer) => reviewer.name === 'quality')).toBe(true);
  });
});
