import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';

import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { MoreThan, type Repository } from 'typeorm';

import { AgentExchangeEntity, DocumentEntity, LoopEventEntity } from '../../history/entities';

import { putStamped } from '../shared/gate.spec-helpers';
import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { VisitRepository } from '../../history/visit.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { buildAgentArgs } from '../../agent/agent-args';

import { PipelineService } from '../../pipeline/pipeline.service';

import { REPORT_CONTINUE, reviewContinue } from './code-review.prompts';

import { ARTIFACTS } from '../contract/artifacts';
import { selectReviewers } from './review-select';
import { answerFor, reply, reportReply, result, boot, seed, writeEnv } from './code-review.step.spec-helpers';
import { storedState } from '../../history/run-state';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { seedCall } from '../../history/agent-call.spec-helpers';

describe('code-review step', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let current: jest.Mock;
  const delegate = jest.fn((...args: unknown[]) => current(...args));

  /** Points the shared application's agent at this test's mock. */
  function useAgent(agent: jest.Mock): void {
    current = agent;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-'));
    await writeEnv(root);
    app = await boot(root, delegate);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('retries an empty review report with the targeted follow-up', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-79', 'billing-api'));
    let reports = 0;
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.step.endsWith('report')) {
        return result(reports++ === 0 ? '' : reportReply('The review holds.'), input.step);
      }
      return result(answerFor(input.step), input.step);
    });
    useAgent(agent);
    await seed(app, 'PROJ-79');
    const done = await app.get(PipelineService).step('code-review', 'PROJ-79');
    const calls = agent.mock.calls.map((call) => call[0]);

    expect(done.exitCode).toBe(0);
    expect(calls.filter((call) => call.step === 'code-review-report')).toHaveLength(2);
    expect(calls.at(-1)?.prompt).toContain('The result block of your last answer was not accepted');
    expect(calls.at(-1)?.prompt).toContain('no result block');
  });

  it('stores three reviews when every decision is ok', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-80', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report') ? reportReply('The parser change holds together.') : reply(input.step, 'ok'),
        input.step,
      ),
    );
    useAgent(agent);
    const exchanges = app.get<Repository<AgentExchangeEntity>>(getRepositoryToken(AgentExchangeEntity));
    const stored = { where: { stepStatId: MoreThan(0) } };
    const exchangesBefore = await exchanges.count(stored);
    await seed(app, 'PROJ-80');
    const done = await app.get(PipelineService).step('code-review', 'PROJ-80');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('review_requirements ok');
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => call.step).sort()).toEqual([
      'code-review-behavior',
      'code-review-code',
      'code-review-report',
      'code-review-requirements',
    ]);
    for (const call of calls) {
      expect(call.tools).toBe('read');
      const args = buildAgentArgs('claude', call);
      expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(expect.arrayContaining(['Edit', 'Write']));
    }
    const reportCall = calls.find((call) => call.step === 'code-review-report');
    expect(reportCall?.model).toBe('opus-5.5-extra-high');
    expect(reportCall?.mode).toBe('ask');
    expect(reportCall?.prompt).toContain('three decisions copied below');
    expect(reportCall?.resumeChatId ?? null).toBeNull();
    expect(reportCall?.continuePrompt).toBe(REPORT_CONTINUE);
    expect(calls.find((call) => call.step === 'code-review-behavior')?.continuePrompt).toBe(reviewContinue('behavior'));
    expect(reportCall?.prompt).toContain('Those decisions are the only reviews');
    expect(reportCall?.prompt).toContain('## Code');
    expect(reportCall?.prompt).toContain('decision: ok');
    expect(reportCall?.prompt).not.toContain('Diff:');
    expect(calls.find((call) => call.step === 'code-review-requirements')?.model).toBe('opus-5.5-extra-high');
    expect(calls.find((call) => call.step === 'code-review-behavior')?.model).toBe('opus-5.5-extra-high');
    expect(calls.find((call) => call.step === 'code-review-code')?.model).toBe('opus-5.5-extra-high');
    expect(calls.find((call) => call.step === 'code-review-code')?.prompt).toContain('Check clarity');
    expect(calls.find((call) => call.step === 'code-review-code')?.prompt).toContain(
      'A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return.',
    );
    expect(calls.find((call) => call.step === 'code-review-code')?.prompt).toContain('/work/brief/diff.md');
    expect(calls.find((call) => call.step === 'code-review-code')?.prompt).toContain('Do not run tests');
    expect(calls.find((call) => call.step === 'code-review-code')?.mode).toBe('ask');
    expect(calls.every((call) => call.liveStep === undefined)).toBe(true);
    expect(calls.every((call) => call.timeLimitMs === 15 * 60 * 1000)).toBe(true);
    expect(calls.every((call) => call.mounts.every((mount) => mount.readonly === true))).toBe(true);
    expect(calls[0]?.prompt).toContain('changed the field parser');
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const runId = (await app.get(RunRepository).findRun('PROJ-80'))!.id;
    const reviews = await documents.find({ where: { runId, kind: 'review_code' } });
    expect(reviews).toHaveLength(1);
    expect(await documents.count({ where: { runId, kind: 'review_requirements' } })).toBe(1);
    expect(await documents.count({ where: { runId, kind: 'review_behavior' } })).toBe(1);
    const report = await documents.findOne({ where: { runId, kind: 'review_report' } });
    expect(report?.body).toContain('## ⏳ Waiting for CI · risk: low\n> The parser change holds together.');
    expect(report?.body).toContain('| Requirements | Checks | CI | Review | Returns | Time |');
    expect(report?.body).toContain('- changed the field');
    expect(report?.body).toContain('<details><summary>Reviewer notes (3)</summary>');
    expect((await exchanges.count(stored)) - exchangesBefore).toBe(4);
    const run = await app.get(RunRepository).findRun('PROJ-80');
    expect(run?.currentStep).toBe('commit');
    expect(run?.status).toBe('waiting');
    expect(run?.attemptsReview).toBe(0);
    await app.get(PipelineService).step('code-review', 'PROJ-80');
    expect(await documents.count({ where: { runId, kind: 'review_code' } })).toBe(1);
    expect((await app.get(RunRepository).findRun('PROJ-80'))?.currentStep).toBe('commit');
  });

  it('puts the Impact section in every reviewer prompt and the report prompt, and leaves it out without a list', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-86', 'billing-api'));
    gitWorktree(join(root, 'worktrees', 'PROJ-87', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('Holds.') : reply(input.step, 'ok'), input.step),
    );
    useAgent(agent);
    await seed(app, 'PROJ-86');
    await seed(app, 'PROJ-87');
    const run = await app.get(RunRepository).findRun('PROJ-87');
    await app.get(DocumentRepository).putDocument(run!, 'impact', '- live agent log | step-documents.tsx | kept\n');
    await app.get(PipelineService).step('code-review', 'PROJ-86');
    const before = agent.mock.calls.length;
    await app.get(PipelineService).step('code-review', 'PROJ-87');
    const plain = agent.mock.calls.slice(0, before).map((call) => call[0]);
    const listed = agent.mock.calls.slice(before).map((call) => call[0]);
    expect(plain).toHaveLength(4);
    expect(plain.some((call) => call.prompt.includes('\nImpact:\n'))).toBe(false);
    expect(listed).toHaveLength(4);
    for (const call of listed) {
      expect(call.prompt).toContain('\nImpact:\n- live agent log | step-documents.tsx | kept');
    }
  });

  it('lists a test the change edits outside its plan, and shows no section for a change inside it', async () => {
    const outside = join(root, 'worktrees', 'PROJ-188', 'billing-api');
    const inside = join(root, 'worktrees', 'PROJ-189', 'billing-api');
    for (const [dir, file] of [
      [outside, 'parser.test.ts'],
      [inside, 'parser.ts'],
    ]) {
      gitWorktree(dir);
      writeFileSync(join(dir, file), 'export const A = 1;\n');
    }
    const agent = jest.fn(async (input: AgentRunInput) => result(answerFor(input.step), input.step));
    useAgent(agent);
    const plan = ARTIFACTS.planResult.format({
      summary: [],
      plan: ['Change the parser - files: parser.ts - proof: parser.spec.ts'],
      questions: [],
      contract: [],
      tasks: [],
      keep: [],
    });
    for (const key of ['PROJ-188', 'PROJ-189']) {
      await seed(app, key);
      await app
        .get(DocumentRepository)
        .putDocument((await app.get(RunRepository).findRun(key))!, ARTIFACTS.planResult.kind, plan);
    }
    await app.get(PipelineService).step('code-review', 'PROJ-188');
    await app.get(PipelineService).step('code-review', 'PROJ-189');
    const reviewers = (key: string) =>
      agent.mock.calls.map((call) => call[0]).filter((call) => call.runKey === key && !call.step.endsWith('report'));
    expect(reviewers('PROJ-188')).toHaveLength(3);
    for (const call of reviewers('PROJ-188')) {
      expect(call.prompt).toContain('\nFiles outside the plan:\nparser.test.ts');
    }
    expect(reviewers('PROJ-189')).toHaveLength(3);
    expect(reviewers('PROJ-189').some((call) => call.prompt.includes('\nFiles outside the plan:\n'))).toBe(false);
  });

  it('runs the three reviewers together and writes the report after they finish', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-81', 'billing-api'));
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
        if (open === 3) releaseReviewers?.();
        await reviewersReady;
        open -= 1;
      }
      return {
        ...result(
          input.step.endsWith('report') ? reportReply('The parser change holds together.') : reply(input.step, 'ok'),
          input.step,
        ),
        samples: [{ sampledAt: new Date().toISOString(), cpuPercent: 22, rssBytes: 4096 }],
      };
    });
    useAgent(agent);
    await seed(app, 'PROJ-81');
    const done = await app.get(PipelineService).step('code-review', 'PROJ-81');
    expect(done.exitCode).toBe(0);
    expect(peak).toBe(3);
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls.at(-1)?.step).toBe('code-review-report');
    const runs = app.get(RunRepository);
    const visits = app.get(VisitRepository);
    const run = await runs.findRun('PROJ-81');
    const stats = await visits.listStats(run!.id);
    const code = stats.find((stat) => stat.step === 'code-review-code');
    expect(code?.cpuPeak).toBe(22);
    expect(code?.status).toBe('done');
    const report = stats.find((stat) => stat.step === 'code-review');
    expect(report?.tokensIn).toBe(10);
    expect(report?.mode).toBe('ask');
    const reportSamples = await visits.listSamples(report ? [report.id] : []);
    expect(reportSamples).toHaveLength(1);
    expect(code?.tokensIn).toBe(10);
  });

  it('returns to implement while attempts_review is below the limit', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-200', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? reportReply('Code found one parser bug. The other checks describe that same bug.', {
              worthALook: [{ place: 'parser.ts', reason: 'Keep the empty segment.' }],
            })
          : reply(input.step, input.step.endsWith('code') ? 'return' : 'ok'),
        input.step,
      ),
    );
    useAgent(agent);
    await seed(app, 'PROJ-200');
    const done = await app.get(PipelineService).step('code-review', 'PROJ-200');
    expect(done.exitCode).toBe(0);
    const run = await app.get(RunRepository).findRun('PROJ-200');
    expect(run?.currentStep).toBe('implement');
    expect(run?.status).toBe('waiting');
    expect(run?.attemptsReview).toBe(1);
    const loops = app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity));
    const events = await loops.find({ where: { runId: run!.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.counter).toBe('review');
    expect(events[0]?.attempt).toBe(1);
    expect(events[0]?.reason).toBe('review_code');
    const notes = await app.get(DocumentRepository).latestBody('PROJ-200', 'return');
    expect(notes).toContain('## code\ncode-review-code');
    const report = await app.get(DocumentRepository).latestBody('PROJ-200', 'review_report');
    expect(report).toContain('## ↩ Sent back · risk: low');
    expect(report).toContain('Keep the empty segment.');
    expect(report).not.toContain('decision: return');
  });

  it('still returns to implement when the prompt names a branch', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-93', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(answerFor(input.step, input.step.endsWith('code') ? 'return' : 'ok')),
    );
    useAgent(agent);
    await seed(app, 'PROJ-93');
    const runs = app.get(RunRepository);
    const seeded = await runs.findRun('PROJ-93');
    if (!seeded) {
      throw new Error('run is missing');
    }
    seeded.prompt = 'branch: feature/other\n';
    await storeRun(runs, seeded);
    const done = await app.get(PipelineService).step('code-review', 'PROJ-93');
    expect(done.exitCode).toBe(0);
    const run = await runs.findRun('PROJ-93');
    expect(run?.currentStep).toBe('implement');
    expect(run?.attemptsReview).toBe(1);
  });

  it('finishes a review return even when attempts_review is already at the limit', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-82', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(answerFor(input.step, input.step.endsWith('code') ? 'return' : 'ok')),
    );
    useAgent(agent);
    await seed(app, 'PROJ-82', 3);
    const done = await app.get(PipelineService).step('code-review', 'PROJ-82');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('waiting');
    const run = await app.get(RunRepository).findRun('PROJ-82');
    expect(run?.currentStep).toBe('implement');
    expect(run?.status).toBe('waiting');
    expect(run?.attemptsReview).toBe(4);
    expect(agent).toHaveBeenCalled();
  });

  it("recovers a reviewer's result block from the log on retry", async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-201', 'billing-api'));
    mkdirSync(join(root, 'data'), { recursive: true });
    await writeFile(
      join(root, 'data', 'PROJ-201-code-review-behavior-output.txt'),
      `${JSON.stringify({ type: 'result', result: reply('code-review-behavior', 'ok') })}\nprocess exited 0\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) => result(reportReply('The three checks agree.'), input.step));
    useAgent(agent);
    await seed(app, 'PROJ-201');
    const runs = app.get(RunRepository);
    const run = await runs.findRun('PROJ-201');
    run!.status = 'failed';
    run!.currentStep = 'code-review';
    await storeRun(runs, run!);
    for (const name of ['requirements', 'code', 'behavior']) {
      await putStamped(app, run!, `review_${name}`, `notes\ndecision: ok\n`, ['billing-api']);
    }
    const done = await app.get(PipelineService).step('code-review', 'PROJ-201');
    expect(done.exitCode).toBe(0);
    expect(agent.mock.calls.map((call) => call[0].step)).toEqual(['code-review-report']);
    expect((await runs.findRun('PROJ-201'))?.currentStep).toBe('commit');
  });

  it('keeps finished reviewers and starts only the one that failed', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-83', 'billing-api'));
    let code = 'notes\n';
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('code') ? code : answerFor(input.step)),
    );
    useAgent(agent);
    await seed(app, 'PROJ-83');
    const failed = await app.get(PipelineService).step('code-review', 'PROJ-83');
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain('no result block');
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const runId = (await app.get(RunRepository).findRun('PROJ-83'))!.id;
    expect(await documents.count({ where: { runId, kind: 'review_code' } })).toBe(0);
    expect(await documents.count({ where: { runId, kind: 'review_behavior' } })).toBe(1);
    expect((await app.get(RunRepository).findRun('PROJ-83'))?.currentStep).toBe('code-review');
    code = reply('code', 'ok');
    agent.mockClear();
    const done = await app.get(PipelineService).step('code-review', 'PROJ-83');
    expect(done.exitCode).toBe(0);
    expect(agent.mock.calls.map((call) => call[0].step)).toEqual(['code-review-code', 'code-review-report']);
    expect((await app.get(RunRepository).findRun('PROJ-83'))?.currentStep).toBe('commit');
  });

  it('blocks a round the machine starts on a run over MAX_RUN_USD, and starts no reviewer and no report', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-84', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) => result(answerFor(input.step)));
    useAgent(agent);
    await seed(app, 'PROJ-84');
    await seedCall(app.get(AgentCallRepository), { runKey: 'PROJ-84', usd: 30 });
    const done = await app.get(PipelineService).step('code-review', 'PROJ-84', { auto: true, startBy: 'machine' });
    expect(done.exitCode).toBe(1);
    expect(agent).not.toHaveBeenCalled();
    const run = await app.get(RunRepository).findRun('PROJ-84');
    expect(storedState(run!)).toMatchObject({ state: 'blocked', reason: { code: 'SPEND_LIMIT' } });
    expect(run?.currentStep).toBe('code-review');
    expect(storedState(run!).reason?.message).toContain('MAX_RUN_USD $25.00');
  });

  it('starts the whole round a person starts on a run over MAX_RUN_USD', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-85', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('The checks are in.') : reply(input.step, 'ok')),
    );
    useAgent(agent);
    await seed(app, 'PROJ-85');
    await seedCall(app.get(AgentCallRepository), { runKey: 'PROJ-85', usd: 30 });
    const done = await app.get(PipelineService).step('code-review', 'PROJ-85', { auto: true });
    expect(done.exitCode).toBe(0);
    expect(agent.mock.calls.map((call) => call[0].step)).toContain('code-review-report');
  });

  it('keeps the reviews of an unchanged approved diff and runs only the report', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-100', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('The checks are in.') : reply(input.step, 'ok')),
    );
    useAgent(agent);
    await seed(app, 'PROJ-100');
    const runs = app.get(RunRepository);
    const first = await app.get(PipelineService).step('code-review', 'PROJ-100');
    expect(first.exitCode).toBe(0);
    const run = await runs.findRun('PROJ-100');
    if (!run) {
      throw new Error('run is missing');
    }
    run.status = 'waiting';
    run.currentStep = 'code-review';
    await storeRun(runs, run);
    agent.mockClear();
    const second = await app.get(PipelineService).step('code-review', 'PROJ-100', { auto: true });
    expect(second.exitCode).toBe(0);
    expect(agent.mock.calls.map((call) => call[0].step)).toEqual(['code-review-report']);
    expect((await runs.findRun('PROJ-100'))?.currentStep).toBe('commit');
  });

  it('reuses stored reviews when Run again left a failed visit waiting', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-88', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(answerFor(input.step, input.step.endsWith('code') || input.step.endsWith('behavior') ? 'return' : 'ok')),
    );
    useAgent(agent);
    await seed(app, 'PROJ-88', 1);
    const runs = app.get(RunRepository);
    const visits = app.get(VisitRepository);
    const run = await runs.findRun('PROJ-88');
    run!.status = 'waiting';
    run!.currentStep = 'code-review';
    await storeRun(runs, run!);
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
      httpCalls: [],
      document: { kind: 'error', fileName: '', body: 'code-review does not fit\n' },
      resumed: false,
    });
    for (const name of ['requirements']) {
      await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
    }
    await putStamped(app, run!, 'review_code', 'theme.alpha\ndecision: return\n', ['billing-api']);
    await putStamped(app, run!, 'review_behavior', 'statusColor\ndecision: return\n', ['billing-api']);
    const done = await app.get(PipelineService).step('code-review', 'PROJ-88');
    expect(done.exitCode).toBe(0);
    expect(agent.mock.calls.map((call) => call[0].step).sort()).toEqual(['code-review-report']);
    const next = await runs.findRun('PROJ-88');
    expect(next?.currentStep).toBe('implement');
    expect(next?.status).toBe('waiting');
    expect(next?.attemptsReview).toBe(2);
  });

  it('continues an interrupted reviewer and keeps a finished return', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-94', 'billing-api'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-94-code-review-behavior-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'behavior-chat', resumed: false, completed: false, killReason: 'time', usd: 1 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('The checks are in.') : reply(input.step, 'ok'), input.step),
    );
    useAgent(agent);
    await seed(app, 'PROJ-94');
    const runs = app.get(RunRepository);
    const run = await runs.findRun('PROJ-94');
    run!.status = 'failed';
    run!.currentStep = 'code-review';
    await storeRun(runs, run!);
    await putStamped(app, run!, 'review_requirements', 'notes\ndecision: return\n', ['billing-api']);
    for (const name of ['code']) {
      await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
    }
    const done = await app.get(PipelineService).step('code-review', 'PROJ-94');
    expect(done.exitCode).toBe(0);
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => call.step)).toEqual(['code-review-behavior', 'code-review-report']);
    expect(calls[0]?.resumeChatId).toBe('behavior-chat');
    expect(calls[0]?.prompt).toContain('You were interrupted before the decision');
    expect(calls[0]?.prompt).not.toContain('Implement and implement-improve have run');
    expect((await runs.findRun('PROJ-94'))?.currentStep).toBe('implement');
  });

  it('does not recover an ok from a reviewer file of an older round', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-older-round-'));
    mkdirSync(join(workdir, 'data'), { recursive: true });
    const finished = (text: string): string =>
      `${JSON.stringify({ type: 'result', result: text })}\nprocess exited 0\n`;
    // Ids sort opposite to age: round 1 is 'zzz' and says ok, round 2 is 'aaa' and says return.
    const older = join(workdir, 'data', 'PROJ-88-code-review-code-zzz-output.txt');
    const newer = join(workdir, 'data', 'PROJ-88-code-review-code-aaa-output.txt');
    writeFileSync(older, finished(reply('code-review-code', 'ok')));
    writeFileSync(newer, finished(reply('code-review-code', 'return')));
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    const documents = { latestBody: async () => null } as unknown as DocumentRepository;
    const input = { key: 'PROJ-88', fresh: false, retry: true };
    const counts = async (): Promise<boolean> => false;
    const second = await selectReviewers(documents, workdir, { ...input, attemptId: 'aaa', counts });
    expect(second.kept.find((item) => item.kind === 'review_code')?.decision).toBe('return');
    const missing = await selectReviewers(documents, workdir, { ...input, attemptId: 'missing', counts });
    expect(missing.kept.find((item) => item.kind === 'review_code')).toBeUndefined();
    expect(missing.pending.some((reviewer) => reviewer.name === 'code')).toBe(true);
  });
});
