import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';

import { mkdtemp } from 'fs/promises';
import { rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { boot, reply, reportReply, result, seed, writeEnv } from './code-review.step.spec-helpers';

const AT = '2026-01-01T00:00:00.000Z';

describe('a code-review round settled by the answers of the planner', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let current: jest.Mock;
  let decisions: Record<string, 'ok' | 'return'>;
  let counter = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-review-planner-answers-'));
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

  const runs = () => app.get(RunRepository);
  const chat = () => app.get(PlanChatStore);

  /**
   * A run whose reviewers returned its tree once; the requirements reviewer returns it again after implement's pass
   * (and so asks the run's planner), while `decisions` says what the others decide. It waits for the planner.
   */
  async function asked(others: Record<string, 'ok' | 'return'> = {}) {
    counter += 1;
    const key = `ANS-${counter}`;
    const tree = join(root, 'worktrees', key, 'billing-api');
    gitWorktree(tree);
    decisions = { requirements: 'return' };
    const launched: string[] = [];
    current = jest.fn(async (input: AgentRunInput) => {
      launched.push(input.step);
      return result(
        input.step.endsWith('report')
          ? reportReply()
          : reply(
              input.step,
              decisions[input.step.replace('code-review-', '')] ?? 'ok',
              input.prompt.includes('Give that one line in `reason`') ? 'It still holds.' : undefined,
            ),
      );
    });
    await seed(app, key);
    const documents = app.get(DocumentRepository);
    const run = (await runs().findRun(key))!;
    await documents.putDocument(
      run,
      'requirements',
      `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove it'], decision: 'approve' } })}\n`,
    );
    await app.get(PipelineService).step('code-review', key);
    decisions = { requirements: 'return', ...others };
    if (Object.keys(others).length > 0) {
      // A new head: the reviewers that passed the first one judge it again.
      writeFileSync(join(tree, 'fix.txt'), 'fixed\n');
    }
    await again(key);
    const [question] = (await chat().read(key)).entries.filter((entry) => entry.kind === 'question');
    expect(question).toMatchObject({ about: 'finding', from: 'code-review-requirements', state: 'pending' });
    launched.length = 0;
    return { key, question, launched, documents };
  }

  async function again(key: string, status: 'waiting' | 'failed' = 'waiting') {
    const run = (await runs().findRun(key))!;
    run.currentStep = 'code-review';
    run.status = status;
    await storeRun(runs(), run);
    return app.get(PipelineService).step('code-review', key);
  }

  async function answer(key: string, question: { key: string }, fields: object) {
    await chat().appendEntry(key, {
      key: `answer-${question.key}`,
      role: 'planner',
      kind: 'answer',
      from: 'code-review-requirements',
      text: 'The planner decided.',
      at: AT,
      state: 'pending',
      ...fields,
    });
    await chat().markTaken(key, [question.key]);
  }

  it('sends a return that holds to implement with the finding and the answer, and starts no reviewer', async () => {
    const { key, question, launched, documents } = await asked();
    await answer(key, question, { finding: 'holds', text: 'Fix the parser first.' });

    const settled = await again(key);

    expect(settled.exitCode).toBe(0);
    expect(launched).toEqual([]);
    expect((await runs().findRun(key))?.currentStep).toBe('implement');
    const notes = await documents.latestBody(key, 'return');
    expect(notes).toContain('code-review-requirements');
    expect(notes).toContain('The planner answered: Fix the parser first.');
    expect((await chat().read(key)).entries.find((entry) => entry.kind === 'answer')?.state).toBe('taken');
  });

  it('stores a ruled-out return as an ok review and goes on with the report only', async () => {
    const { key, question, launched, documents } = await asked();
    await answer(key, question, { finding: 'ruled-out', text: 'The brief removes it.' });

    await again(key);

    expect(launched).toEqual(['code-review-report']);
    expect((await runs().findRun(key))?.currentStep).toBe('commit');
    const review = await documents.latestBody(key, 'review_requirements');
    expect(review).toContain('decision: ok');
    expect(review).toContain('reason: The planner ruled the finding out: The brief removes it.');
  });

  it('sends an instruction of the planner to implement although the finding is ruled out', async () => {
    const { key, question, launched, documents } = await asked();
    await answer(key, question, { finding: 'ruled-out', instruction: 'Drop the catch-up too.' });

    await again(key);

    expect(launched).toEqual([]);
    expect((await runs().findRun(key))?.currentStep).toBe('implement');
    expect(await documents.latestBody(key, 'return')).toContain('Drop the catch-up too.');
  });

  it('sends the return of a reviewer that did not ask with the round', async () => {
    const { key, question, launched, documents } = await asked({ code: 'return' });
    await answer(key, question, { finding: 'ruled-out' });

    await again(key);

    expect(launched).toEqual([]);
    expect((await runs().findRun(key))?.currentStep).toBe('implement');
    const notes = await documents.latestBody(key, 'return');
    expect(notes).toContain('## code');
    expect(notes).not.toContain('## requirements');
  });

  it('keeps the round waiting while a question has no answer', async () => {
    const { key, launched } = await asked();

    const waiting = await again(key);

    expect(waiting.exitCode).toBe(0);
    expect(launched).toEqual([]);
    const run = await runs().findRun(key);
    expect(run?.currentStep).toBe('code-review');
    expect(run?.status).toBe('waiting');
    expect(run?.stateReason).toContain('ASKS_PLANNER');
  });

  it('keeps a question the planner escalated waiting for the person, not for the planner', async () => {
    const { key, question, launched } = await asked();
    await chat().appendEntry(key, {
      key: `escalate-${question.key}`,
      role: 'planner',
      kind: 'escalation',
      from: 'code-review-requirements',
      text: 'A product decision.',
      at: AT,
      state: 'pending',
    });
    await chat().markTaken(key, [question.key]);

    await again(key);

    expect(launched).toEqual([]);
    const run = await runs().findRun(key);
    expect(run?.status).toBe('waiting');
    expect(run?.stateReason ?? '').not.toContain('ASKS_PLANNER');
  });

  it('goes on as an ok round when a retried visit settles a ruled-out finding', async () => {
    const { key, question, launched, documents } = await asked();
    await answer(key, question, { finding: 'ruled-out', text: 'The brief removes it.' });

    await again(key, 'failed');

    expect(launched).toEqual(['code-review-report']);
    expect((await runs().findRun(key))?.currentStep).toBe('commit');
    expect(await documents.latestBody(key, 'review_requirements')).toContain('decision: ok');
  });

  it('reads the answers of the last round only: answers that were taken start the reviewers again', async () => {
    const { key, question, launched } = await asked();
    await answer(key, question, { finding: 'holds' });
    await again(key);
    expect((await runs().findRun(key))?.currentStep).toBe('implement');

    await again(key);

    expect(launched).toContain('code-review-requirements');
  });
});
