import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer } from '../../testing/result-answer';
import { boot, result, seed, writeEnv } from './plan-improve.step.spec-helpers';

const KEY = 'PROJ-61';
const LIST = Array.from({ length: 9 }, (_, index) => ({ id: `R${index + 1}`, text: `requirement ${index + 1}` }));
const COVERAGE = LIST.map((requirement) => ({ ...requirement, items: ['add the field'] }));
const IDS = LIST.map((requirement) => requirement.id);
const R10 = { id: 'R10', text: 'requirement 10' };

const answer = (extra: Record<string, unknown>): string =>
  resultAnswer('Done.', { summary: ['checked the list'], plan: [], ...extra });

async function improveWith(answers: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-coverage-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', KEY, 'billing-api'), { recursive: true });
  const agent = jest.fn();
  for (const text of answers) agent.mockResolvedValueOnce(result(text));
  const app = await boot(root, agent);
  try {
    await seed(app, KEY);
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(KEY))!;
    await runs.saveRun({ ...run, split: false });
    const documents = app.get(DocumentRepository);
    await documents.putDocument(run, 'requirement_list', `${JSON.stringify(LIST)}\n`);
    await documents.putDocument(run, 'requirement_coverage', `${JSON.stringify(COVERAGE)}\n`);
    const done = await app.get(PipelineService).step('plan-improve', KEY);
    const body = async (kind: string): Promise<{ id: string; items?: string[] }[]> =>
      JSON.parse((await documents.latestBody(KEY, kind)) ?? 'null');
    return {
      done,
      prompts: agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt),
      list: await body('requirement_list'),
      coverage: await body('requirement_coverage'),
      handoff: await documents.latestBody(KEY, 'handoff'),
    };
  } finally {
    await app.close();
  }
}

describe('plan-improve coverage', () => {
  it('writes the merged list when it adds a requirement research missed, and checks coverage on the result', async () => {
    const added = answer({
      summary: ['R10 added: the input asks for it and research missed it'],
      plan: ['add the field', 'add R10'],
      covers: [IDS, ['R10']],
      requirements: [R10],
    });
    const run = await improveWith([added]);
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain('R9: requirement 9');
    expect(run.list.map((entry) => entry.id)).toHaveLength(10);
    expect(run.coverage[9]).toMatchObject({ id: 'R10', items: ['add R10'] });
    expect(run.handoff).toContain('R10 added: the input asks for it');
  });

  it('sends an added requirement that no item covers back in the same chat', async () => {
    const uncovered = answer({ plan: ['add the field'], covers: [IDS], requirements: [R10] });
    const fixed = answer({ plan: ['add the field', 'add R10'], covers: [IDS, ['R10']], requirements: [R10] });
    const run = await improveWith([uncovered, fixed]);
    expect(run.prompts[1]).toContain('R10 is not covered: requirement 10');
    expect(run.coverage[9].items).toEqual(['add R10']);
  });

  it('keeps a requirement the first answer added when the follow-up leaves requirements out', async () => {
    const uncovered = answer({ plan: ['add the field'], covers: [IDS], requirements: [R10] });
    const fixed = answer({ plan: ['add the field', 'add R10'], covers: [IDS, ['R10']] });
    const run = await improveWith([uncovered, fixed]);
    expect(run.list).toHaveLength(10);
    expect(run.coverage[9].items).toEqual(['add R10']);
  });

  it('sends a renumbered id back with the result follow-up', async () => {
    const renumbered = answer({ requirements: [{ id: 'R11', text: 'requirement 11' }] });
    const run = await improveWith([renumbered, answer({})]);
    expect(run.prompts[1]).toContain('R11 is not the next requirement id, which is R10');
    expect(run.list).toHaveLength(9);
  });

  it('keeps the stored coverage for an empty plan and checks it against the new list', async () => {
    const kept = await improveWith([answer({})]);
    expect(kept.prompts).toHaveLength(1);
    expect(kept.coverage).toEqual(COVERAGE);
    const grown = await improveWith([
      answer({ requirements: [R10] }),
      answer({ plan: ['add the field', 'add R10'], covers: [IDS, ['R10']] }),
    ]);
    expect(grown.prompts[1]).toContain('R10 is not covered: requirement 10');
  });
});
