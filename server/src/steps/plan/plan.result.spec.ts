import 'reflect-metadata';
import { readFileSync, mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer } from '../../testing/result-answer';
import { boot, planBlock, result, seed, writeEnv } from './plan.step.spec-helpers';

const TASK = { id: 'a', title: 'Add it', depends: [], files: ['a.ts'], proof: 'a.spec.ts', description: 'Adds it.' };
const split = (tasks: unknown[]): string => resultAnswer('Done.', { summary: ['why'], contract: ['rule'], tasks });

/** Runs the plan step of a run that may split with these answers, one per launch. */
async function planWith(key: string, answers: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-result-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(result(answer));
  const app = await boot(root, agent);
  try {
    await seed(app, key, '');
    const runs = app.get(RunRepository);
    await runs.saveRun({ ...(await runs.findRun(key))!, split: true });
    const done = await app.get(PipelineService).step('plan', key);
    const documents = app.get(DocumentRepository);
    const stored: Record<string, string | null> = {};
    for (const kind of ['subtasks', 'requirements']) stored[kind] = await documents.latestBody(key, kind);
    return {
      done,
      prompts: agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt),
      body: (kind: string) => stored[kind] ?? null,
    };
  } finally {
    await app.close();
  }
}

describe('plan step result block', () => {
  it('stores the four tasks of the f49 plan with whole descriptions', async () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'f49-plan.answer.md'), 'utf8');
    const out = await planWith('PROJ-200', [text]);
    expect(out.done.exitCode).toBe(0);
    const tasks = JSON.parse(out.body('subtasks') ?? '[]');
    expect(tasks.map((task: { id: string }) => task.id)).toHaveLength(4);
    expect(tasks[0].description).toContain('- cursor reads AGENTS.md\n\nThe adapter spec pins both.');
  });

  it('stores a description with colons, nested lists, numbered lines, blank lines and code whole', async () => {
    const description = 'Does it:\n- nested: yes\n  - deeper\n1. first\n\n```ts\nconst a = { b: 1 };\n```';
    const out = await planWith('PROJ-201', [split([{ ...TASK, description }])]);
    expect(JSON.parse(out.body('subtasks') ?? '[]')[0].description).toBe(description);
  });

  it('writes the plan of a block as the prose reader wrote it', async () => {
    const out = await planWith('PROJ-202', [planBlock(['add the field', 'cover the empty case'])]);
    expect(JSON.parse(out.body('requirements') ?? '{}').plan).toEqual({
      name: '',
      overview: '',
      items: ['add the field', 'cover the empty case'],
      decision: null,
    });
  });

  it('asks again when a plan tool was used and no block was sent, and takes the block of the second answer', async () => {
    const out = await planWith('PROJ-203', ['I wrote the plan with the plan tool.', planBlock(['add the field'])]);
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts).toHaveLength(2);
    expect(out.prompts[1]).toContain('the answer has no result block');
    expect(JSON.parse(out.body('requirements') ?? '{}').plan.items).toEqual(['add the field']);
  });

  it('sends a task with no proof back to the agent in the follow-up, and passes when it is fixed', async () => {
    const out = await planWith('PROJ-204', [split([{ ...TASK, proof: ' ' }]), split([TASK])]);
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts[1]).toContain('task a has no proof');
    expect(JSON.parse(out.body('subtasks') ?? '[]')).toHaveLength(1);
  });

  it('fails the step with the errors after a third invalid answer', async () => {
    const bad = split([{ ...TASK, proof: '' }]);
    const out = await planWith('PROJ-205', [bad, bad, bad]);
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('tasks.0.proof');
    expect(out.prompts).toHaveLength(3);
  });

  it('fails when the second answer is fixed but still invalid and the third is invalid too', async () => {
    const out = await planWith('PROJ-206', [
      split([{ ...TASK, proof: '' }]),
      split([{ ...TASK, depends: ['nope'] }]),
      split([{ ...TASK, files: [] }]),
    ]);
    expect(out.done.exitCode).toBe(1);
    expect(out.prompts[2]).toContain('depends on unknown task nope');
    expect(out.done.message).toContain('task a has no file to change');
  });
});
