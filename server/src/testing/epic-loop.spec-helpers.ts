import { mkdirSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import type { StepName } from '../contract/steps';
import type { Subtask } from '../contract/subtask';
import type { StepOptions } from '../core/pipeline-result';
import { AgentCallRepository } from '../history/agent-call.repository';
import { DocumentRepository } from '../history/document.repository';
import { writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { installScripts } from '../pipeline/run-driver.spec-helpers';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { renderNeeds } from '../steps/shared/needs';
import type { Step, StepSnapshot } from '../steps/step';
import { StepRegistry } from '../steps/step.registry';
import type { createFlowHarness } from './flow-harness';
import { loggedCall, save } from './runs.spec-helpers';
import { storeRun } from './store-run.spec-helpers';

/** What the scripted agent of the looping task says at every visit. */
export const LOOP_WORDS = 'I cannot decide which retry policy wins; b has merged and says nothing about it.';

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

/**
 * The 21.11 loop of an epic `key`: its subtask `<key>-a` runs a scripted implement that ends every visit on the same
 * need on a sibling `<key>-b` that has merged, so a machine start of that task is refused as the same input of its
 * last visit. `seed` stores the epic, and `fakeAgent` gives the task its own steps while the epic's stay the real ones.
 */
export function epicLoop(flow: Awaited<ReturnType<typeof createFlowHarness>>, key: string) {
  const taskKey = `${key}-a`;
  const requirements = `${JSON.stringify({
    prompt: 'Ship the field\n',
    tickets: [{ key, summary: 'Ship the field' }],
    plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
  })}\n`;
  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);

  /** Waits until no command and no driver of the epic or the task is left running. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await flow.app.app.get(CommandService).idle();
      await flow.app.pipeline.whenIdle(key);
      await flow.app.pipeline.whenIdle(taskKey);
    }
  }

  /** The task runs its own steps: its agent writes the same need on b at every visit. Returns the task's visit count. */
  function fakeAgent(): () => number {
    const registry = flow.app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
    const real = registry.get('implement')!;
    const steps = installScripts(
      flow.app,
      {
        implement: async (_visit, ctx) => {
          await ctx.write(ARTIFACTS.needs, renderNeeds([{ id: 'b', what: 'which retry policy wins' }]));
          const now = ctx.clock.iso();
          const call = await loggedCall(flow.app.app.get(AgentCallRepository), {
            model: 'fake',
            startedAt: now,
            finishedAt: now,
            durationMs: 0,
            requestText: 'implement',
            responseText: LOOP_WORDS,
          });
          return { outcome: 'waiting', exitCode: 0, code: ERROR_CODES.SUBTASK_WAITING, visit: { callIds: [call] } };
        },
      },
      ['implement'],
    );
    const scripted = registry.get('implement')!;
    const others = registry.get.bind(registry);
    const pick = (runKey: string) => (runKey === taskKey ? scripted : real);
    registry.get = (name) =>
      name !== 'implement'
        ? others(name)
        : new Proxy(real, {
            get: (target, prop) => {
              if (prop === 'usesModel') return true;
              if (prop === 'execute')
                return (runKey: string, options: StepOptions, snapshot?: StepSnapshot) =>
                  pick(runKey).execute(runKey, options, snapshot);
              if (prop === 'missingInput')
                return (runKey: string, options: StepOptions) => pick(runKey).missingInput(runKey, options);
              const value: unknown = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
    // The task's detached starts reach the real driver; the others of its siblings are only recorded.
    const detached = PipelineService.prototype.startDetached.bind(flow.app.pipeline);
    jest.spyOn(flow.app.pipeline, 'startDetached').mockImplementation((runKey, ...rest) => {
      if (runKey === key || runKey === taskKey) return detached(runKey, ...rest);
      flow.launched.push(runKey);
      return Promise.resolve({ exitCode: 0, message: `${runKey} started` });
    });
    return () => steps.get('implement')?.count ?? 0;
  }

  /** b merged at some time, then the epic's pass saw it; the task waits at implement with its worktree folder in place. */
  async function seed(): Promise<void> {
    const parent = await save(runs(), key, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b')])}\n`);
    await flow.app.pipeline.step('implement', key);
    await flow.app.app.get(CommandService).idle();
    const merged = (await runs().findRun(`${key}-b`))!;
    await documents().putDocument(merged, 'requirements', requirements);
    await documents().putDocument(merged, 'repos', 'demo\n');
    const record = {
      project: 'demo',
      iid: 1,
      url: 'https://code.example/demo/1',
      draft: false,
      summary: 'adds the retry policy',
    };
    await documents().putDocument(merged, 'merge_request', renderMergeRequest([record]));
    writeRunState(merged, { status: 'done', currentStep: 'done' });
    await storeRun(runs(), merged);
    await flow.app.pipeline.step('implement', key);
    await flow.app.app.get(CommandService).idle();
    const waiting = (await runs().findRun(taskKey))!;
    await documents().putDocument(waiting, 'requirements', requirements);
    await documents().putDocument(waiting, 'repos', 'demo\n');
    writeRunState(waiting, { status: 'waiting', currentStep: 'implement' });
    await storeRun(runs(), waiting);
    mkdirSync(join(flow.app.root, 'worktrees', taskKey, 'demo'), { recursive: true });
    flow.app.clock.advance(60_000);
  }

  return { taskKey, settle, seed, fakeAgent };
}
