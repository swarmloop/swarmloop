import { SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import { result } from '../implement/implement.step.spec-helpers';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import { withPlan } from '../plan/plan-record';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { PlanImproveStep } from './plan-improve.step';

const KEY = 'PROJ-50';

async function improve(agent: jest.Mock) {
  const golden = await goldenApp('plan-improve-golden', { agent, worktrees: [`${KEY}/billing-api`] });
  const seeded = await golden.runs.begin(KEY, 'plan-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan-improve';
  await golden.runs.saveRun(seeded);
  const unreviewed = { name: '', overview: '', items: ['add the field'], decision: null };
  await golden.seedDocuments.putDocument(seeded, 'requirements', withPlan('{"prompt":"ship the field"}\n', unreviewed));
  await golden.seedDocuments.putDocument(seeded, 'repos', 'billing-api\n');
  const step = new PlanImproveStep(
    new StepKernel(golden.runs, golden.documents, golden.visits, golden.flows, golden.clock, golden.config),
    golden.sandbox,
    golden.agent,
  );
  return { golden, step };
}

describe('plan-improve step golden traces', () => {
  const scenarios: [string, jest.Mock][] = [
    ['ok', jest.fn().mockResolvedValue(result(['plan:', '- add the field', '- cover the empty case'].join('\n')))],
    ['swarmloop-error', jest.fn().mockRejectedValue(new SwarmloopError('agent refused the task'))],
    ['plain-error', jest.fn().mockRejectedValue(new Error('agent crashed'))],
  ];
  it.each(scenarios)('%s', async (name, agent) => {
    const { golden, step } = await improve(agent);
    try {
      await step.execute(KEY);
      expectGolden(`plan-improve.${name}`, await golden.trace(KEY, 'plan-improve'));
    } finally {
      await golden.close();
    }
  });
});
