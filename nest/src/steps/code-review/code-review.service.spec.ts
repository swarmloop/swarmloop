import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { AgentExchangeEntity, DocumentEntity, LoopEventEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunInput, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { REPORT_CONTINUE, reviewContinue } from './code-review.prompts';
import { REBASE_CONFLICT } from '../../git/rebase-worktree';

describe('code-review step', () => {
  it('stores five reviews when every decision is ok', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-80', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The parser change holds together.\n' : 'notes\n\ndecision: ok\n', input.step),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-80');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-80');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('review_requirements ok');
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
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
      expect(calls.find((call) => call.step === 'code-review-security')?.continuePrompt).toBe(reviewContinue('security'));
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
      const run = await app.get(HistoryService).findRun('PROJ-80');
      expect(run?.currentStep).toBe('commit');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsReview).toBe(0);
      await app.get(PipelineService).step('code-review', 'PROJ-80');
      expect(await documents.count({ where: { kind: 'review_quality' } })).toBe(1);
      expect((await app.get(HistoryService).findRun('PROJ-80'))?.currentStep).toBe('commit');
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
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (!input.step.endsWith('report')) {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 30));
        open -= 1;
      }
      return {
        ...result(input.step.endsWith('report') ? 'The parser change holds together.\n' : 'notes\n\ndecision: ok\n', input.step),
        samples: [{ sampledAt: new Date().toISOString(), cpuPercent: 22, rssBytes: 4096 }],
      };
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-81');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-81');
      expect(done.exitCode).toBe(0);
      expect(peak).toBe(5);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls.at(-1)?.step).toBe('code-review-report');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-81');
      const stats = await history.listStats(run!.id);
      const quality = stats.find((stat) => stat.step === 'code-review-quality');
      expect(quality?.cpuPeak).toBe(22);
      expect(quality?.status).toBe('done');
      const report = stats.find((stat) => stat.step === 'code-review');
      expect(report?.tokensIn).toBe(10);
      expect(report?.mode).toBe('ask');
      const reportSamples = await history.listSamples(report ? [report.id] : []);
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
      const run = await app.get(HistoryService).findRun('PROJ-81');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsReview).toBe(1);
      const loops = app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity));
      const events = await loops.find();
      expect(events).toHaveLength(1);
      expect(events[0]?.counter).toBe('review');
      expect(events[0]?.attempt).toBe(1);
      expect(events[0]?.reason).toBe('review_quality');
      const notes = await app.get(HistoryService).latestBody('PROJ-81', 'return');
      expect(notes).toContain('What to fix:');
      expect(notes).toContain('Keep the empty segment.');
      expect(notes).not.toContain('decision: return');
      const report = await app.get(HistoryService).latestBody('PROJ-81', 'review_report');
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
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-93');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-93');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.prompt = 'branch: feature/other\n';
      await history.saveRun(seeded);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-93');
      expect(done.exitCode).toBe(0);
      const run = await history.findRun('PROJ-93');
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
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-82', 3);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-82');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('waiting');
      const run = await app.get(HistoryService).findRun('PROJ-82');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-87');
      run!.status = 'failed';
      run!.currentStep = 'code-review';
      await history.saveRun(run!);
      for (const name of ['requirements', 'quality', 'regressions', 'security']) {
        await history.putDocument(run!, `review_${name}`, `notes\ndecision: ok\n`);
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-87');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(1);
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).step).toBe('code-review-report');
      expect((await history.findRun('PROJ-87'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('keeps finished reviewers and starts only the one that failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-retry-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-83', 'billing-api'), { recursive: true });
    let quality = 'notes\n';
    const agent = jest.fn(async (input: AgentRunInput) => result(input.step.endsWith('quality') ? quality : reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-83');
      const failed = await app.get(PipelineService).step('code-review', 'PROJ-83');
      expect(failed.exitCode).toBe(1);
      expect(failed.message).toContain('decision is missing');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect(await documents.count({ where: { kind: 'review_quality' } })).toBe(0);
      expect(await documents.count({ where: { kind: 'review_security' } })).toBe(1);
      expect((await app.get(HistoryService).findRun('PROJ-83'))?.currentStep).toBe('code-review');
      quality = reply('quality', 'ok');
      agent.mockClear();
      const done = await app.get(PipelineService).step('code-review', 'PROJ-83');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).step).toBe('code-review-quality');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).step).toBe('code-review-report');
      expect((await app.get(HistoryService).findRun('PROJ-83'))?.currentStep).toBe('commit');
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
      const run = await app.get(HistoryService).findRun('PROJ-84');
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
    const agent = jest.fn(async (input: AgentRunInput) => result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-100');
      const history = app.get(HistoryService);
      const first = await app.get(PipelineService).step('code-review', 'PROJ-100');
      expect(first.exitCode).toBe(0);
      const run = await history.findRun('PROJ-100');
      if (!run) {
        throw new Error('run is missing');
      }
      run.agentCalls = 15;
      run.status = 'waiting';
      run.currentStep = 'code-review';
      await history.saveRun(run);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-100', { auto: true });
      expect(second.exitCode).toBe(0);
      expect(second.message).not.toContain('does not fit');
      expect(agent.mock.calls.map((call) => (call[0] as AgentRunInput).step)).toEqual(['code-review-report']);
      expect((await history.findRun('PROJ-100'))?.currentStep).toBe('commit');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-88');
      run!.status = 'waiting';
      run!.currentStep = 'code-review';
      await history.saveRun(run!);
      const now = new Date().toISOString();
      await history.finishVisit(run!, {
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
        await history.putDocument(run!, `review_${name}`, 'notes\ndecision: ok\n');
      }
      await history.putDocument(run!, 'review_quality', 'theme.alpha\ndecision: return\n');
      await history.putDocument(run!, 'review_regressions', 'statusColor\ndecision: return\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-88');
      expect(done.message).not.toContain('does not fit');
      expect(agent.mock.calls.map((call) => (call[0] as AgentRunInput).step).sort()).toEqual(['code-review-report']);
      const next = await history.findRun('PROJ-88');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-94');
      run!.status = 'failed';
      run!.currentStep = 'code-review';
      await history.saveRun(run!);
      await history.putDocument(run!, 'review_requirements', 'notes\ndecision: return\n');
      for (const name of ['quality', 'regressions', 'performance']) {
        await history.putDocument(run!, `review_${name}`, 'notes\ndecision: ok\n');
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-94');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls.map((call) => call.step)).toEqual(['code-review-security', 'code-review-report']);
      expect(calls[0]?.resumeChatId).toBe('security-chat');
      expect(calls[0]?.prompt).toContain('You were interrupted before the decision');
      expect(calls[0]?.prompt).not.toContain('Implement and implement-improve have run');
      expect((await history.findRun('PROJ-94'))?.currentStep).toBe('implement');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-89');
      await history.putDocument(run!, 'review_requirements', 'notes\ndecision: ok\n');
      await history.putDocument(run!, 'review_security', 'notes\ndecision: ok\n');
      await history.putDocument(run!, 'review_performance', 'notes\ndecision: ok\n');
      await history.putDocument(run!, 'review_regressions', 'notes\ndecision: return\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-89', { reviewer: 'quality' });
      expect(agent).toHaveBeenCalledTimes(1);
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).step).toBe('code-review-quality');
      expect(done.exitCode).toBe(0);
      const next = await history.findRun('PROJ-89');
      expect(next?.currentStep).toBe('code-review');
      expect(next?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('continues when the last open reviewer passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-last-ok-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-90', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'ok')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-90');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-90');
      for (const name of ['requirements', 'regressions', 'security', 'performance']) {
        await history.putDocument(run!, `review_${name}`, 'notes\ndecision: ok\n');
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-90', { reviewer: 'quality' });
      expect(done.exitCode).toBe(0);
      expect((await history.findRun('PROJ-90'))?.currentStep).toBe('commit');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-91');
      for (const name of ['requirements', 'regressions', 'security', 'performance']) {
        await history.putDocument(run!, `review_${name}`, 'notes\ndecision: ok\n');
      }
      const done = await app.get(PipelineService).step('code-review', 'PROJ-91', { reviewer: 'quality' });
      expect(done.exitCode).toBe(0);
      const next = await history.findRun('PROJ-91');
      expect(next?.currentStep).toBe('implement');
      expect(next?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('reviews a checkout path without returning to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-path-'));
    const checkout = await mkdtemp(join(tmpdir(), 'swarmloop-checkout-'));
    await writeEnv(root);
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, 'return')));
    const app = await boot(root, agent);
    try {
      const done = await app.get(PipelineService).step('code-review', 'PROJ-85', { path: checkout });
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls.every((call) => call.mounts[0]?.containerPath === '/work' && call.mounts[0]?.readonly === true)).toBe(true);
      const run = await app.get(HistoryService).findRun('PROJ-85');
      expect(run?.currentStep).toBe('commit');
      expect(run?.attemptsReview).toBe(0);
      expect(run?.targetPath).toBe(realpathSync(checkout));
      const loops = app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity));
      expect(await loops.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('resumes a checkout review from the stored path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-resume-'));
    const checkout = await mkdtemp(join(tmpdir(), 'swarmloop-checkout-resume-'));
    await writeEnv(root);
    let quality = 'notes\n';
    const agent = jest.fn(async (input: AgentRunInput) => result(input.step.endsWith('quality') ? quality : reply(input.step, 'ok')));
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
      const call = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(call.step).toBe('code-review-quality');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).step).toBe('code-review-report');
      expect(call.mounts[0]?.hostPath).toBe(realpathSync(checkout));
      const run = await app.get(HistoryService).findRun('PROJ-86');
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
      const run = await app.get(HistoryService).findRun('PROJ-87');
      await app.get(HistoryService).putDocument(run!, 'handoff', '## implement\n- changed the parser\n\n## implement-improve\n- kept the parser\n');
      await app.get(HistoryService).putDocument(run!, 'return', '## quality\nuse theme.alpha\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-87');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
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
      const handoff = await app.get(HistoryService).latestBody('PROJ-87', 'handoff');
      expect(handoff).toContain('## implement');
      expect(handoff).toContain('## implement-improve');
      expect(handoff).toContain('## quality');
      expect(handoff).toContain('## requirements');
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
      const run = await app.get(HistoryService).findRun('PROJ-86');
      await app.get(HistoryService).putDocument(run!, 'implementation', '- checked the parser\n');
      await app.get(HistoryService).putDocument(run!, 'handoff', '## implement\n- the parser had to match the field\n\n## implement-improve\n- the first pass already did\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-86');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-97');
      run!.currentStep = 'code-review';
      run!.status = 'failed';
      await history.saveRun(run!);
      await history.putDocument(run!, 'review_quality', 'notes\n\ndecision: ok\n');
      await history.putDocument(run!, REBASE_CONFLICT, 'review\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-97');
      expect(done.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      const reviewers = calls.filter((call) => call.step !== 'code-review-report');
      expect(reviewers.map((call) => call.step).sort()).toEqual(
        ['requirements', 'quality', 'regressions', 'security', 'performance'].map((name) => `code-review-${name}`).sort(),
      );
      const quality = reviewers.find((call) => call.step === 'code-review-quality');
      expect(quality?.resumeChatId ?? null).toBeNull();
      expect((await history.findRun('PROJ-97'))?.attemptsReview).toBe(0);
      expect(quality?.prompt).not.toContain('This chat is only the quality angle');
      expect(quality?.prompt).toContain('/work/brief/diff.md');
      expect((await history.latestBody('PROJ-97', REBASE_CONFLICT))?.trim()).toBe('clear');
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
    const agent = jest.fn(async (input: AgentRunInput) => result(reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok')));
    const app = await boot(root, agent);
    try {
      const history = app.get(HistoryService);
      const seeded = await history.begin('PROJ-88', 'code-review');
      seeded.status = 'waiting';
      seeded.currentStep = 'requirements';
      seeded.ownerPid = null;
      seeded.projects = 'app\n';
      seeded.prompt = 'https://example/browse/PROJ-88\nbranch: feature/other\n';
      await history.saveRun(seeded);
      await history.noteFlow('PROJ-88', ['requirements', 'code-review'], null);
      await history.putDocument(seeded, 'requirements', '{}\n');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-88');
      expect(done.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-88', 'app');
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      expect(calls).toHaveLength(6);
      expect(
        calls.every((call) => call.mounts[0]?.readonly === true && realpathSync(call.mounts[0].hostPath) === realpathSync(worktree)),
      ).toBe(true);
      expect(calls[0]?.prompt).toContain('Clean worktree');
      expect(calls[0]?.prompt).toContain('NEXT');
      expect(calls[0]?.prompt).not.toContain('local.txt');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/feature/other']));
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      const run = await history.findRun('PROJ-88');
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
      const history = app.get(HistoryService);
      const seeded = await history.begin('PROJ-89', 'code-review');
      seeded.status = 'waiting';
      seeded.currentStep = 'requirements';
      seeded.ownerPid = null;
      seeded.projects = 'app\n';
      seeded.prompt = 'Review the checkout\n';
      await history.saveRun(seeded);
      await history.noteFlow('PROJ-89', ['code-review'], null);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-89');
      expect(done.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-89', 'app');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      expect((await history.findRun('PROJ-89'))?.attemptsReview).toBe(0);
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-95');
      expect(run?.currentStep).toBe('commit');
      const stats = await history.listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'code-review-security')).toHaveLength(1);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const logs = await documents.find({ where: { kind: 'log' } });
      const body = logs.map((item) => item.body).join('\n');
      expect(body).toContain('security-attempt-1');
      expect(body).toContain('security-attempt-2');
      expect(body).toContain('security-finished');
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
      const run = await app.get(HistoryService).findRun('PROJ-96');
      expect(run?.currentStep).toBe('code-review');
      const stats = await app.get(HistoryService).listStats(run?.id ?? 0);
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
      expect((await app.get(HistoryService).findRun('PROJ-101'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('does not send the same diff back to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-same-diff-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-98', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, input.step.endsWith('requirements') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-98');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-98');
      await history.putDocument(
        run!,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove the pending rebase catch-up'], decision: 'approve' } })}\n`,
      );
      const first = await app.get(PipelineService).step('code-review', 'PROJ-98');
      expect(first.exitCode).toBe(0);
      expect((await history.findRun('PROJ-98'))?.currentStep).toBe('implement');
      const sent = agent.mock.calls.map((call) => call[0] as AgentRunInput).find((call) => call.step === 'code-review-requirements');
      expect(sent?.prompt).toContain('Remove the pending rebase catch-up');
      expect(sent?.prompt).toContain('A behavior it removes is not a missing requirement');
      expect(sent?.prompt).toContain('The list below is the current one');
      expect(sent?.prompt).toContain('is required and is never returned');
      const again = await history.findRun('PROJ-98');
      again!.currentStep = 'code-review';
      again!.status = 'waiting';
      await history.saveRun(again!);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-98');
      expect(second.exitCode).toBe(0);
      const resumed = agent.mock.calls.map((call) => call[0] as AgentRunInput).find((call) => call.step === 'code-review-requirements');
      expect(resumed?.prompt).toContain('Do not return that behavior again');
      expect(resumed?.prompt).toContain('Remove the pending rebase catch-up');
      expect(resumed?.prompt).toContain('The list below is the current one');
      expect(resumed?.prompt).toContain('Do not return a finding that brings back what the failing pipeline log shows as the cause');
      const next = await history.findRun('PROJ-98');
      expect(next?.currentStep).toBe('commit');
      expect(next?.attemptsReview).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('shows the plan again when resume keeps a return of the same diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-same-diff-resume-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-99', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, input.step.endsWith('requirements') ? 'return' : 'ok')),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-99');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-99');
      await history.putDocument(
        run!,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove the pending rebase catch-up'], decision: 'approve' } })}\n`,
      );
      const first = await app.get(PipelineService).step('code-review', 'PROJ-99');
      expect(first.exitCode).toBe(0);
      const again = await history.findRun('PROJ-99');
      again!.currentStep = 'code-review';
      again!.status = 'failed';
      await history.saveRun(again!);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-99');
      expect(second.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0] as AgentRunInput);
      const resumed = calls.find((call) => call.step === 'code-review-requirements');
      expect(calls.map((call) => call.step).sort()).toEqual(['code-review-report', 'code-review-requirements']);
      expect(resumed?.prompt).toContain('Remove the pending rebase catch-up');
      expect(resumed?.prompt).toContain('Do not return that behavior again');
      expect(resumed?.prompt).not.toContain('You were interrupted before the decision');
      const next = await history.findRun('PROJ-99');
      expect(next?.currentStep).toBe('commit');
      expect(next?.attemptsReview).toBe(1);
    } finally {
      await app.close();
    }
  });
});

function reply(step: string, decision: 'ok' | 'return'): string {
  return `${step}\n\ndecision: ${decision}\n`;
}

function result(responseText: string, step = 'code-review'): AgentRunResult {
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

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, attemptsReview = 0, agentCalls = 0): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'code-review');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement-improve';
  seeded.attemptsReview = attemptsReview;
  seeded.agentCalls = agentCalls;
  await history.saveRun(seeded);
  await history.putDocument(seeded, 'requirements', `${JSON.stringify({ prompt: 'Ship the field\n' })}\n`);
  await history.putDocument(seeded, 'repos', 'billing-api\n');
  await history.putDocument(seeded, 'implementation', '- changed the field parser\n');
}

async function bootLive(root: string, spawn: jest.Mock): ReturnType<typeof boot> {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'price-cache-cursor.json'), `${JSON.stringify({ fetchedAt: new Date().toISOString(), prices: {} })}\n`);
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

function reviewSpawn(succeedOn: number): jest.Mock {
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

function launches(spawn: jest.Mock, step: string): unknown[][] {
  return spawn.mock.calls.filter((call) => (call[0] as { step?: string }).step === step);
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

async function writeEnv(root: string, checkoutsRoot?: string, maxLaunches = 3, reviewTimeout = 900000): Promise<void> {
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
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      checkoutsRoot === undefined ? '' : `CHECKOUTS_ROOT=${checkoutsRoot}`,
      '',
    ].join('\n'),
  );
}

function repoWithBranch(root: string, dirName: string): string {
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
