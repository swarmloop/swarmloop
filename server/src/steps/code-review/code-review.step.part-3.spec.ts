import 'reflect-metadata';

import { mkdirSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { reply, result, boot, seed, writeEnv } from './code-review.step.spec-helpers';

describe('code-review step', () => {
  it('does not send the same diff back to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-same-diff-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-98', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? 'The checks are in.\n'
          : reply(input.step, input.step.endsWith('requirements') ? 'return' : 'ok'),
      ),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-98');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-98');
      await documents.putDocument(
        run!,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove the pending rebase catch-up'], decision: 'approve' } })}\n`,
      );
      const first = await app.get(PipelineService).step('code-review', 'PROJ-98');
      expect(first.exitCode).toBe(0);
      expect((await runs.findRun('PROJ-98'))?.currentStep).toBe('implement');
      const sent = agent.mock.calls.map((call) => call[0]).find((call) => call.step === 'code-review-requirements');
      expect(sent?.prompt).toContain('Remove the pending rebase catch-up');
      expect(sent?.prompt).toContain('A behavior it removes is not a missing requirement');
      expect(sent?.prompt).toContain('The list below is the current one');
      expect(sent?.prompt).toContain('is required and is never returned');
      const again = await runs.findRun('PROJ-98');
      again!.currentStep = 'code-review';
      again!.status = 'waiting';
      await runs.saveRun(again!);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-98');
      expect(second.exitCode).toBe(0);
      const resumed = agent.mock.calls.map((call) => call[0]).find((call) => call.step === 'code-review-requirements');
      expect(resumed?.prompt).toContain('Do not return that behavior again');
      expect(resumed?.prompt).toContain('Remove the pending rebase catch-up');
      expect(resumed?.prompt).toContain('The list below is the current one');
      expect(resumed?.prompt).toContain(
        'Do not return a finding that brings back what the failing pipeline log shows as the cause',
      );
      const next = await runs.findRun('PROJ-98');
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
      result(
        input.step.endsWith('report')
          ? 'The checks are in.\n'
          : reply(input.step, input.step.endsWith('requirements') ? 'return' : 'ok'),
      ),
    );
    const app = await boot(root, agent);
    try {
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
      const again = await runs.findRun('PROJ-99');
      again!.currentStep = 'code-review';
      again!.status = 'failed';
      await runs.saveRun(again!);
      agent.mockClear();
      const second = await app.get(PipelineService).step('code-review', 'PROJ-99');
      expect(second.exitCode).toBe(0);
      const calls = agent.mock.calls.map((call) => call[0]);
      const resumed = calls.find((call) => call.step === 'code-review-requirements');
      expect(calls.map((call) => call.step).sort()).toEqual(['code-review-report', 'code-review-requirements']);
      expect(resumed?.prompt).toContain('Remove the pending rebase catch-up');
      expect(resumed?.prompt).toContain('Do not return that behavior again');
      expect(resumed?.prompt).not.toContain('You were interrupted before the decision');
      const next = await runs.findRun('PROJ-99');
      expect(next?.currentStep).toBe('commit');
      expect(next?.attemptsReview).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('gives the regressions reviewer of a split run the keep lines and makes no run from them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-keep-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-97', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => result(`notes\n\ndecision: ok\n`, input.step));
    const app = await boot(root, agent);
    try {
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
    } finally {
      await app.close();
    }
  });
});
