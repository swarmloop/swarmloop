import { SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import { result } from '../implement/implement.step.spec-helpers';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import { resultAnswer } from '../../testing/result-answer';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { ResearchStep } from './research.step';

const KEY = 'PROJ-20';

async function research(agent: jest.Mock) {
  const golden = await goldenApp('research-golden', { agent, worktrees: [`${KEY}/billing-api`, `${KEY}/catalog-api`] });
  const seeded = await golden.runs.begin(KEY, 'prepare');
  seeded.status = 'waiting';
  seeded.currentStep = 'research';
  await golden.runs.saveRun(seeded);
  await golden.seedDocuments.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
  const step = new ResearchStep(
    new StepKernel(
      golden.runs,
      golden.documents,
      golden.visits,
      golden.flows,
      golden.clock,
      golden.config,
      golden.stepEvents,
    ),
    golden.sandbox,
    golden.launcher,
  );
  return { golden, step };
}

describe('research step golden traces', () => {
  const scenarios: [string, jest.Mock][] = [
    [
      'ok',
      jest.fn().mockResolvedValue(result(resultAnswer('Done.', { summary: ['looked'], questions: [], impact: [] }))),
    ],
    [
      'questions-open',
      jest
        .fn()
        .mockResolvedValue(
          result(resultAnswer('Done.', { summary: ['looking'], questions: ['which field is optional?'], impact: [] })),
        ),
    ],
    ['swarmloop-error', jest.fn().mockRejectedValue(new SwarmloopError('agent refused the task'))],
    ['plain-error', jest.fn().mockRejectedValue(new Error('agent crashed'))],
  ];
  it.each(scenarios)('%s', async (name, agent) => {
    const { golden, step } = await research(agent);
    try {
      await step.execute(KEY);
      expectGolden(`research.${name}`, await golden.trace(KEY, 'research'));
    } finally {
      await golden.close();
    }
  });
});
