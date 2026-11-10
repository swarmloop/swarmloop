import { SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import { result } from '../implement/implement.step.spec-helpers';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import type { Subtask } from '../../contract/subtask';
import { withPlan } from '../plan/plan-record';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { PlanImproveStep } from './plan-improve.step';

const KEY = 'PROJ-50';

const SPLIT_TASKS = [
  taskOf('column', 'Add the column', 'none', 'server/src/history/migrations/index.ts'),
  taskOf('index', 'Add the index', 'none', 'server/src/history/migrations/index.ts'),
];

function taskOf(id: string, title: string, depends: string, file: string): Subtask {
  return {
    id,
    title,
    description: `${title}.`,
    depends: depends === 'none' ? [] : [depends],
    files: [file],
    proof: `${id}.spec.ts`,
    status: 'pending',
  };
}

const line = (task: Subtask): string =>
  `- ${task.id} | ${task.title} | depends: ${task.depends.join(', ') || 'none'} | files: ${task.files.join(', ')} | proof: ${task.proof}\n  ${task.description}`;

const splitAnswer = (tasks: Subtask[]): string =>
  ['contract:', '- the column is called `split`', '', 'tasks:', ...tasks.map(line), '', 'summary:', '- checked'].join(
    '\n',
  );

async function improve(agent: jest.Mock, tasks: Subtask[] = []) {
  const golden = await goldenApp('plan-improve-golden', { agent, worktrees: [`${KEY}/billing-api`] });
  const seeded = await golden.runs.begin(KEY, 'plan-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan-improve';
  seeded.split = tasks.length > 0;
  await golden.runs.saveRun(seeded);
  const unreviewed = { name: '', overview: '', items: ['add the field'], decision: null };
  await golden.seedDocuments.putDocument(seeded, 'requirements', withPlan('{"prompt":"ship the field"}\n', unreviewed));
  await golden.seedDocuments.putDocument(seeded, 'repos', 'billing-api\n');
  if (tasks.length > 0) {
    await golden.seedDocuments.putDocument(seeded, 'subtasks', `${JSON.stringify(tasks)}\n`);
    await golden.seedDocuments.putDocument(seeded, 'contract', '- the column is called `split`\n');
  }
  const step = new PlanImproveStep(
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

  const splitScenarios: [string, Subtask[], Subtask[]][] = [
    ['split-ok', [SPLIT_TASKS[0], { ...SPLIT_TASKS[1], files: ['server/src/b.ts'] }], []],
    ['split-shared-file', SPLIT_TASKS, [SPLIT_TASKS[0], { ...SPLIT_TASKS[1], depends: ['column'] }]],
    [
      'split-parallel-file',
      [SPLIT_TASKS[0], { ...SPLIT_TASKS[1], files: ['server/src/a.ts'] }],
      [
        { ...SPLIT_TASKS[0], files: ['server/src/a.ts'] },
        { ...SPLIT_TASKS[1], files: ['server/src/a.ts'], depends: ['column'] },
      ],
    ],
  ];
  it.each(splitScenarios)('split on: %s', async (name, seeded, returned) => {
    const answer = splitAnswer(returned.length > 0 ? returned : seeded);
    const { golden, step } = await improve(jest.fn().mockResolvedValue(result(answer)), seeded);
    try {
      await step.execute(KEY);
      expectGolden(`plan-improve.${name}`, await golden.trace(KEY, 'plan-improve'));
    } finally {
      await golden.close();
    }
  });
});
