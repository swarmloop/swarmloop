import { SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import { result } from '../implement/implement.step.spec-helpers';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { PlanStep } from './plan.step';

const KEY = 'PROJ-40';

async function plan(agent: jest.Mock, questions: string) {
  const golden = await goldenApp('plan-golden', { agent, worktrees: [`${KEY}/billing-api`] });
  const seeded = await golden.runs.begin(KEY, 'plan');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan';
  await golden.runs.saveRun(seeded);
  await golden.seedDocuments.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
  await golden.seedDocuments.putDocument(seeded, 'repos', 'billing-api\n');
  await golden.seedDocuments.putDocument(seeded, 'questions', questions);
  const step = new PlanStep(
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

describe('plan step golden traces', () => {
  const written = result(['plan:', '- add the field', '- cover the empty case'].join('\n'));
  const scenarios: [string, jest.Mock, string][] = [
    ['plan-written', jest.fn().mockResolvedValue(written), ''],
    ['questions-open', jest.fn().mockResolvedValue(written), '- which field is optional?\n'],
    ['swarmloop-error', jest.fn().mockRejectedValue(new SwarmloopError('agent refused the task')), ''],
    ['plain-error', jest.fn().mockRejectedValue(new Error('agent crashed')), ''],
  ];
  it.each(scenarios)('%s', async (name, agent, questions) => {
    const { golden, step } = await plan(agent, questions);
    try {
      await step.execute(KEY);
      expectGolden(`plan.${name}`, await golden.trace(KEY, 'plan'));
    } finally {
      await golden.close();
    }
  });
});
