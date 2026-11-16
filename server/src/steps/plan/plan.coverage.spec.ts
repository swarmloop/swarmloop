import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer } from '../../testing/result-answer';
import { boot, result, seed, writeChat, writeEnv } from './plan.step.spec-helpers';

const LIST = Array.from({ length: 9 }, (_, index) => ({ id: `R${index + 1}`, text: `requirement ${index + 1}` }));
const ITEMS = LIST.map((requirement) => `do ${requirement.id} - files: a.ts - proof: a.spec.ts`);
const TASKS = [
  { id: 't1', title: 'Task one', files: ['f1.ts'], proof: 'f1.spec.ts', covers: ['R1', 'R2', 'R3', 'R4', 'R5'] },
  { id: 't2', title: 'Task two', files: ['f2.ts'], proof: 'f2.spec.ts', covers: ['R6', 'R7', 'R8', 'R9'] },
].map((task) => ({ ...task, depends: [], description: 'Does it.' }));

const covering = (count: number, extra: Record<string, unknown> = {}): string =>
  resultAnswer('Done.', {
    summary: ['why'],
    plan: ITEMS.slice(0, count),
    covers: ITEMS.slice(0, count).map((_, index) => [`R${index + 1}`]),
    ...extra,
  });

const split = (tasks: unknown[]): string => resultAnswer('Done.', { summary: ['why'], contract: ['rule'], tasks });

interface Options {
  list?: boolean;
  chat?: boolean;
  split?: boolean;
}

async function planWith(answers: string[], options: Options = {}) {
  const key = 'PROJ-60';
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-coverage-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  if (options.chat) writeChat(root, key);
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(result(answer));
  const app = await boot(root, agent);
  try {
    await seed(app, key, '');
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(key))!;
    await runs.saveRun({ ...run, split: options.split ?? false });
    const documents = app.get(DocumentRepository);
    if (options.list ?? true) await documents.putDocument(run, 'requirement_list', `${JSON.stringify(LIST)}\n`);
    const done = await app.get(PipelineService).step('plan', key);
    const body = async (kind: string): Promise<unknown> =>
      JSON.parse((await documents.latestBody(key, kind)) ?? 'null');
    return {
      done,
      prompts: agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt),
      coverage: (await body('requirement_coverage')) as { id: string; items: string[] }[] | null,
      subtasks: (await body('subtasks')) as { covers?: string[] }[] | null,
      handoff: await documents.latestBody(key, 'handoff'),
      state: (await runs.findRun(key))?.status,
    };
  } finally {
    await app.close();
  }
}

const GAP = 'R9 is not covered: requirement 9';

describe('plan coverage', () => {
  it('sends a plan that covers eight of nine back once in the same chat and accepts the fixed plan', async () => {
    const run = await planWith([covering(8), covering(9)]);
    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[1]).toContain(GAP);
    expect(run.prompts[1]).not.toContain('R1: requirement 1');
    expect(run.coverage?.map((entry) => entry.items.length)).toEqual(Array(9).fill(1));
    expect(run.handoff).not.toContain('coverage gap');
  });

  it('sends a plan that names an id that is no requirement back with that id', async () => {
    const run = await planWith([
      covering(9, { covers: [...ITEMS.map((_, i) => [`R${i + 1}`]).slice(0, 8), ['R9', 'R12']] }),
      covering(9),
    ]);
    expect(run.prompts[1]).toContain('R12 is not a requirement');
  });

  it('accepts a plan that is still uncovered and writes the gap into its handoff', async () => {
    const run = await planWith([covering(8), covering(8)]);
    expect(run.prompts).toHaveLength(2);
    expect(run.done.exitCode).toBe(0);
    expect(run.handoff).toContain(`coverage gap: ${GAP}`);
    expect(run.coverage?.[8].items).toEqual([]);
  });

  it('accepts a run with no requirement list with no follow-up and no coverage document', async () => {
    const run = await planWith([covering(8)], { list: false });
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).not.toContain('R1: requirement 1');
    expect(run.coverage).toBeNull();
    expect(run.done.exitCode).toBe(0);
  });

  it('checks a split plan through the covers of each task and stores them on the subtasks', async () => {
    const run = await planWith([split(TASKS)], { split: true });
    expect(run.prompts).toHaveLength(1);
    expect(run.coverage?.every((entry) => entry.items.length === 1)).toBe(true);
    expect(run.subtasks?.map((task) => task.covers?.length)).toEqual([5, 4]);
  });

  it('sends a split plan with an uncovered requirement back', async () => {
    const run = await planWith([split([TASKS[0], { ...TASKS[1], covers: ['R6'] }]), split(TASKS)], { split: true });
    expect(run.prompts[1]).toContain('R7 is not covered: requirement 7');
  });

  it('leaves the list out of a prompt that resumes the research chat and holds it once in a fresh one', async () => {
    const resumed = await planWith([covering(9)], { chat: true });
    expect(resumed.prompts[0]).not.toContain('R1: requirement 1');
    const fresh = await planWith([covering(9)]);
    expect(fresh.prompts[0].split('R9: requirement 9')).toHaveLength(2);
    expect(fresh.prompts[0]).toContain('R9: requirement 9');
  });
});
