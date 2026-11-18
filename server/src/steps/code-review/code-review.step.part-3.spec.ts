import 'reflect-metadata';

import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { mkdirSync, rmSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { resultAnswer } from '../../testing/result-answer';

import { PipelineService } from '../../pipeline/pipeline.service';

import * as delays from '../../core/delay';
import { clearGitFaults, failGit } from '../../testing/git-fault.spec-helpers';
import { git } from '../../testing/git-fixture';
import { checkoutFingerprint } from '../shared/gate';

import { answerFor, reply, reportReply, result, boot, seed, writeEnv } from './code-review.step.spec-helpers';

import type * as GitFault from '../../testing/git-fault.spec-helpers';

jest.mock('child_process', () =>
  jest.requireActual<typeof GitFault>('../../testing/git-fault.spec-helpers').faultyChildProcess(),
);

describe('code-review step', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let current: jest.Mock;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-exchange-'));
    await writeEnv(root);
    app = await boot(
      root,
      jest.fn((...args: unknown[]) => current(...args)),
    );
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A run whose requirements reviewer returned the diff once and is back in code-review on the same diff. */
  async function returnedOnce(
    key: string,
    answer: string | null,
    decision: 'ok' | 'return',
    reason = 'The answer holds.',
    subtask = false,
  ) {
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    let again: 'ok' | 'return' = 'return';
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? reportReply('The checks are in.')
          : reply(
              input.step,
              input.step.endsWith('requirements') ? again : 'ok',
              input.prompt.includes('Give that one line in `reason`') ? reason : undefined,
            ),
      ),
    );
    current = agent;
    await seed(app, key);
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun(key);
    if (subtask) {
      run!.parentRunId = 1;
      await runs.saveRun(run!);
    }
    await documents.putDocument(
      run!,
      'requirements',
      `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove the pending rebase catch-up'], decision: 'approve' } })}\n`,
    );
    const first = await app.get(PipelineService).step('code-review', key);
    expect(first.exitCode).toBe(0);
    expect((await runs.findRun(key))?.currentStep).toBe('implement');
    if (answer) {
      await documents.putDocument(
        run!,
        'implementation_result',
        JSON.stringify({
          implementation: ['changed nothing'],
          summary: ['kept'],
          rejected: [{ reviewer: 'requirements', finding: 'requirements', reason: answer }],
        }),
      );
    }
    again = decision;
    const waiting = await runs.findRun(key);
    waiting!.currentStep = 'code-review';
    waiting!.status = 'waiting';
    await runs.saveRun(waiting!);
    agent.mockClear();
    const second = await app.get(PipelineService).step('code-review', key);
    expect(second.exitCode).toBe(0);
    const sent = (step: string): AgentRunInput | undefined =>
      agent.mock.calls.map((call) => call[0]).find((call) => call.step === step);
    return { app, runs, documents, agent, sent, run: run! };
  }

  it('asks the person when a reviewer returns the same diff again', async () => {
    const { runs, documents, run, sent } = await returnedOnce('PROJ-98', null, 'return', 'It still holds.', true);
    const prompt = sent('code-review-requirements')?.prompt ?? '';
    expect(prompt).toContain('Remove the pending rebase catch-up');
    expect(prompt).toContain('Do not return that behavior again');
    expect(prompt).toContain('Your last finding and the answer of implement');
    expect(prompt).toContain('Implement gave no answer to this finding.');
    expect(sent('code-review-quality')?.prompt ?? '').not.toContain('Your last finding');
    const waiting = await runs.findRun('PROJ-98');
    expect(waiting?.currentStep).toBe('code-review');
    expect(waiting?.status).toBe('waiting');
    expect(await documents.latestBody('PROJ-98', 'review_questions')).toContain(
      'requirements still returns: code-review-requirements Implement answered: nothing. Which holds?',
    );
    expect(await documents.latestBody('PROJ-98', 'review_requirements')).toBe(
      'code-review-requirements\ndecision: return\nreason: It still holds.\n',
    );
    expect(run.attemptsReview).toBe(0);
  });

  it('asks the planner first when a reviewer of a run returns the same diff again, and not the person', async () => {
    const { runs, documents, sent } = await returnedOnce('PROJ-94', null, 'return', 'It still holds.');
    expect(sent('code-review-requirements')?.prompt).toContain('Your last finding and the answer of implement');
    const waiting = await runs.findRun('PROJ-94');
    expect(waiting?.currentStep).toBe('code-review');
    expect(waiting?.status).toBe('waiting');
    expect(await documents.latestBody('PROJ-94', 'review_questions')).toBeNull();
    const chat = JSON.parse((await documents.latestBody('PROJ-94', 'plan_chat')) ?? '{}');
    expect(chat.entries).toEqual([
      expect.objectContaining({
        kind: 'question',
        from: 'code-review-requirements',
        state: 'pending',
        text: expect.stringContaining(
          'requirements still returns: code-review-requirements Implement answered: nothing.',
        ),
      }),
    ]);
  });

  it('puts the answer of implement and the decision of the person into the next round', async () => {
    const { app, runs, documents, run, sent, agent } = await returnedOnce(
      'PROJ-96',
      'The plan removes it.',
      'return',
      'It still holds.',
      true,
    );
    expect(sent('code-review-requirements')?.prompt).toContain('Implement answered: The plan removes it.');
    const question = (await documents.latestBody('PROJ-96', 'review_questions'))!.replace(/^- /, '').trim();
    expect(question).toContain('Implement answered: The plan removes it.');
    await app.get(PipelineService).step('code-review', 'PROJ-96');
    expect((await runs.findRun('PROJ-96'))?.currentStep).toBe('code-review');
    await documents.putDocument(run, 'answers', `question: ${question}\nanswer: Keep the catch-up\n`);
    const settled = await app.get(PipelineService).step('code-review', 'PROJ-96');
    expect(settled.exitCode).toBe(0);
    expect((await runs.findRun('PROJ-96'))?.currentStep).toBe('implement');
    expect(await documents.latestBody('PROJ-96', 'review_questions')).toBe('');
    expect(await documents.latestBody('PROJ-96', 'return')).toContain('The person decided: Keep the catch-up');
    expect(await documents.latestBody('PROJ-96', 'requirements')).toContain('A person decided on the code review');
    const again = await runs.findRun('PROJ-96');
    again!.currentStep = 'code-review';
    again!.status = 'waiting';
    await runs.saveRun(again!);
    agent.mockClear();
    await app.get(PipelineService).step('code-review', 'PROJ-96');
    expect(sent('code-review-requirements')?.prompt ?? '').toContain('A person decided on the code review');
  });

  it('goes on when the reviewer accepts the answer of implement, and stores the reviewer reason', async () => {
    const { runs, documents, sent } = await returnedOnce('PROJ-95', 'The plan removes it.', 'ok');
    expect(sent('code-review-requirements')?.prompt).toContain('Implement answered: The plan removes it.');
    expect((await runs.findRun('PROJ-95'))?.currentStep).toBe('commit');
    expect(await documents.latestBody('PROJ-95', 'review_requirements')).toBe(
      'code-review-requirements\ndecision: ok\nreason: The answer holds.\n',
    );
    expect(await documents.latestBody('PROJ-95', 'review_questions')).toBeNull();
  });

  it('shows the plan again when resume keeps a return of the same diff', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-99', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? reportReply('The checks are in.')
          : reply(input.step, input.step.endsWith('requirements') ? 'return' : 'ok'),
      ),
    );
    current = agent;
    await seed(app, 'PROJ-99');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-99');
    await documents.putDocument(
      run!,
      'requirements',
      `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove the pending rebase catch-up'], decision: 'approve' } })}\n`,
    );
    const first = await app.get(PipelineService).step('code-review', 'PROJ-99');
    expect(first.exitCode).toBe(0);
    const shown = agent.mock.calls.map((call) => call[0]).find((call) => call.step === 'code-review-requirements');
    expect(shown?.prompt).toContain('Remove the pending rebase catch-up');
    expect(shown?.prompt).toContain('Do not return that behavior again');
    const again = await runs.findRun('PROJ-99');
    again!.currentStep = 'code-review';
    again!.status = 'failed';
    await runs.saveRun(again!);
    agent.mockClear();
    const second = await app.get(PipelineService).step('code-review', 'PROJ-99');
    expect(second.exitCode).toBe(0);
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => call.step)).toEqual(['code-review-report']);
    const next = await runs.findRun('PROJ-99');
    expect(next?.currentStep).toBe('implement');
    expect(next?.attemptsReview).toBe(2);
    expect(await documents.latestBody('PROJ-99', 'review_requirements')).toContain('decision: return');
  });

  it('does not wait for a planner when a reviewer of a run that never planned asks a question', async () => {
    mkdirSync(join(root, 'worktrees', 'PROJ-92', 'billing-api'), { recursive: true });
    current = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? reportReply('The checks are in.')
          : resultAnswer(input.step, {
              decision: 'ok',
              review: input.step,
              summary: [input.step],
              question: 'Which of the two is meant?',
            }),
      ),
    );
    await seed(app, 'PROJ-92');

    const outcome = await app.get(PipelineService).step('code-review', 'PROJ-92');

    expect(outcome.exitCode).toBe(0);
    const run = await app.get(RunRepository).findRun('PROJ-92');
    expect(run?.currentStep).toBe('commit');
    const chat = await app.get(DocumentRepository).latestBody('PROJ-92', 'plan_chat');
    expect(chat).toBeNull();
  });

  it('gives the regressions reviewer of a split run the keep lines and makes no run from them', async () => {
    gitWorktree(join(root, 'worktrees', 'PROJ-97', 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) => result(answerFor(input.step), input.step));
    current = agent;
    await seed(app, 'PROJ-97');
    const runs = app.get(RunRepository);
    const run = await runs.findRun('PROJ-97');
    run!.split = true;
    await runs.saveRun(run!);
    const documents = app.get(DocumentRepository);
    await documents.putDocument(
      run!,
      'keep',
      JSON.stringify([{ capability: 'login works', proof: 'login.spec.ts', tasks: ['a'] }]),
    );
    await documents.putDocument(run!, 'subtasks', JSON.stringify([]));
    const done = await app.get(PipelineService).step('code-review', 'PROJ-97');
    expect(done.exitCode).toBe(0);
    const sent = agent.mock.calls.map((call) => call[0]).filter((call) => call.step.startsWith('code-review-'));
    const holding = sent.filter((call) => call.prompt.includes('- login works (proof: login.spec.ts)'));
    expect(holding.map((call) => call.step)).toEqual(['code-review-regressions']);
    expect(holding[0].prompt).toContain('Check each line against the merged diff');
    expect(await runs.children(run!)).toEqual([]);
  });

  describe('the fingerprint the review stamps', () => {
    afterEach(() => {
      clearGitFaults();
      jest.restoreAllMocks();
    });

    it('is the name-only one for a checkout that is a subdirectory of a repository, which is reviewed as before', async () => {
      const repo = join(root, 'worktrees', 'checkout-repo');
      mkdirSync(join(repo, 'sub'), { recursive: true });
      git(repo, ['init', '-q']);
      const checkout = join(repo, 'sub');
      current = jest.fn(async (input: AgentRunInput) => result(answerFor(input.step), input.step));

      const done = await app.get(PipelineService).step('code-review', 'PROJ-198', { path: checkout });

      expect(done.exitCode).toBe(0);
      const stamp = await app.get(DocumentRepository).latestStamp('PROJ-198', 'review_quality');
      expect(stamp?.fingerprint).toBe(await checkoutFingerprint([checkout]));
    });

    it("stamps nothing and fails the step with git's text when the probe of the worktree fails", async () => {
      jest.spyOn(delays, 'delay').mockResolvedValue(undefined);
      gitWorktree(join(root, 'worktrees', 'PROJ-199', 'billing-api'));
      const agent = jest.fn(async (input: AgentRunInput) => result(answerFor(input.step), input.step));
      current = agent;
      await seed(app, 'PROJ-199');
      failGit(['rev-parse', '--show-toplevel'], { stderr: 'fatal: detected dubious ownership in repository' }, 2);

      const done = await app.get(PipelineService).step('code-review', 'PROJ-199');

      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('dubious ownership');
      expect(agent).not.toHaveBeenCalled();
      expect(await app.get(DocumentRepository).latestStamp('PROJ-199', 'review_quality')).toBeNull();
      expect((await app.get(RunRepository).findRun('PROJ-199'))?.status).toBe('failed');
    });
  });
});
