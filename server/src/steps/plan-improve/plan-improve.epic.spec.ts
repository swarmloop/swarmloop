import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import type { StepName } from '../../contract/steps';
import { VisitRepository } from '../../history/visit.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { boot, result } from '../code-review/code-review.step.spec-helpers';
import { writeEnv } from '../implement/implement.step.spec-helpers';
import { BranchStep } from '../branch/branch.step';
import { resultAnswer } from '../../testing/result-answer';
import { withPlan } from '../plan/plan-record';

const task = { title: 'Add the column', description: 'Adds it.', depends: [], files: ['a.ts'], proof: 'a.spec.ts' };
const stored = [{ ...task, id: 'column', status: 'pending' }];
const tasksAnswer = (title: string, depends: string[] = []): string =>
  resultAnswer('Done.', {
    summary: ['checked'],
    contract: ['the column is called `split_on`'],
    tasks: [{ ...task, id: 'column', title, depends }],
  });
const planAnswer = resultAnswer('Done.', { summary: ['one run'], plan: ['add the field'] });

/** A split run waiting at `start`, with `EPIC_EFFORT` as given. */
async function epicApp(key: string, epicEffort: string, answers: string[], start: StepName = 'plan-improve') {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-epic-'));
  await writeEnv(root);
  const envFile = join(root, '.env');
  const env = readFileSync(envFile, 'utf8')
    .replaceAll('=cursor:', '=claude:')
    .replace('EPIC_EFFORT=', `EPIC_EFFORT=${epicEffort}`);
  writeFileSync(envFile, env);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(result(answer, 'plan-improve'));
  const app = await boot(root, agent);
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, start);
  seeded.status = 'waiting';
  seeded.currentStep = start;
  seeded.split = true;
  await runs.saveRun(seeded);
  const unreviewed = { name: '', overview: '', items: ['add the field'], decision: null };
  await documents.putDocument(seeded, 'requirements', withPlan('{"prompt":"ship the field"}\n', unreviewed));
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
  await documents.putDocument(seeded, 'subtasks', `${JSON.stringify(stored)}\n`);
  await documents.putDocument(seeded, 'contract', '- the column is called `split`\n');
  const input = (call: number) => agent.mock.calls[call]?.[0] as AgentRunInput;
  const visit = () => app.get(PipelineService).step('plan-improve', key);
  const state = async () => ({
    run: await runs.findRun(key),
    subtasks: JSON.parse((await documents.latestBody(key, 'subtasks')) ?? '[]') as { title: string }[],
  });
  return { app, input, visit, state, runs };
}

describe('plan-improve step of an epic', () => {
  it('marks a fresh split and plans once more at the epic effort before any subtask exists', async () => {
    const { app, input, visit, state } = await epicApp('PROJ-70', 'xhigh', [
      tasksAnswer('First graph'),
      tasksAnswer('Checked graph'),
    ]);
    try {
      await visit();
      const marked = await state();
      expect(marked.run?.epicAt).toBeTruthy();
      expect(marked.run?.currentStep).toBe('plan-improve');
      expect(marked.subtasks.map((item) => item.title)).toEqual(['First graph']);
      expect(input(0).effort).toBeUndefined();

      const second = await visit();
      expect(second.exitCode).toBe(0);
      expect(input(1).effort).toBe('xhigh');
      expect(input(1).prompt).toContain('First graph');
      const after = await state();
      expect(after.run?.currentStep).toBe('branch');
      expect(after.run?.epicAt).toBeTruthy();
      expect(after.subtasks.map((item) => item.title)).toEqual(['Checked graph']);
    } finally {
      await app.close();
    }
  });

  it('runs the same checks on the extra visit', async () => {
    const { app, visit, state } = await epicApp('PROJ-71', 'xhigh', [
      tasksAnswer('First graph'),
      ...Array.from({ length: 3 }, () => tasksAnswer('Broken', ['nope'])),
    ]);
    try {
      await visit();
      const second = await visit();
      expect(second.exitCode).toBe(1);
      expect(second.message).toContain('task column depends on unknown task nope');
      expect((await state()).subtasks.map((item) => item.title)).toEqual(['First graph']);
    } finally {
      await app.close();
    }
  });

  it('turns a split back into one plan and clears the mark', async () => {
    const { app, visit, state } = await epicApp('PROJ-72', 'xhigh', [tasksAnswer('First graph'), planAnswer]);
    try {
      await visit();
      await visit();
      const after = await state();
      expect(after.run?.epicAt).toBeNull();
      expect(after.run?.currentStep).toBe('branch');
      expect(after.subtasks).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('routes next as before when EPIC_EFFORT is empty', async () => {
    const { app, visit, state } = await epicApp('PROJ-73', '', [tasksAnswer('First graph')]);
    try {
      await visit();
      const after = await state();
      expect(after.run?.epicAt).toBeNull();
      expect(after.run?.currentStep).toBe('branch');
    } finally {
      await app.close();
    }
  });

  it('goes from plan through the epic pass of plan-improve to branch', async () => {
    const { app, input, state, runs } = await epicApp(
      'PROJ-74',
      'xhigh',
      [tasksAnswer('First graph'), tasksAnswer('Checked graph')],
      'plan',
    );
    try {
      jest.spyOn(app.get(BranchStep), 'execute').mockResolvedValue({ exitCode: 0, message: 'branch' });
      await app.get(PipelineService).runThrough('PROJ-74');
      const run = await runs.findRun('PROJ-74');
      const visited = (await app.get(VisitRepository).listStats(run!.id)).map((item) => item.step);
      expect(visited).toEqual(['plan', 'plan-improve', 'plan-improve']);
      expect(input(1).effort).toBe('xhigh');
      expect(run?.epicAt).toBeTruthy();
      expect(run?.currentStep).toBe('branch');
      expect((await state()).subtasks.map((item) => item.title)).toEqual(['Checked graph']);
    } finally {
      await app.close();
    }
  });
});
