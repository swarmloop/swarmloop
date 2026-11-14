import { SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import { result } from '../implement/implement.step.spec-helpers';
import { resultAnswer } from '../../testing/result-answer';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { PlanStep } from './plan.step';

const KEY = 'PROJ-40';

async function plan(agent: jest.Mock, questions: string, split = false) {
  const golden = await goldenApp('plan-golden', { agent, worktrees: [`${KEY}/billing-api`] });
  const seeded = await golden.runs.begin(KEY, 'plan');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan';
  seeded.split = split;
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

const splitReply = result(
  resultAnswer('Done.', {
    summary: ['two parts'],
    contract: ['the column is called `split`'],
    tasks: [
      {
        id: 'column',
        title: 'Add the column',
        depends: [],
        files: ['server/src/a.ts'],
        proof: 'a.spec.ts "reads it"',
        description: 'Adds the column.',
      },
      {
        id: 'api',
        title: 'Send it',
        depends: ['column'],
        files: ['server/src/b.ts'],
        proof: 'b.spec.ts "sends it"',
        description: 'Sends it.',
      },
    ],
  }),
);

describe('plan step golden traces', () => {
  const written = result(
    resultAnswer('Done.', { summary: ['covers the empty case'], plan: ['add the field', 'cover the empty case'] }),
  );
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

  it('split on: split-written', async () => {
    const { golden, step } = await plan(jest.fn().mockResolvedValue(splitReply), '', true);
    try {
      await step.execute(KEY);
      expectGolden('plan.split-written', await golden.trace(KEY, 'plan'));
    } finally {
      await golden.close();
    }
  });
});
