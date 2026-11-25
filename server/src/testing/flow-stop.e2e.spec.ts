import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { Reconciler } from '../pipeline/reconciler';
import { SubtaskPort } from '../pipeline/subtask-port';
import { REASON, STOP_NOTE } from '../contract/run-state';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { save } from './runs.spec-helpers';

const KEY = 'PROJ-470';
const MINUTE = 60_000;

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

describe('a person’s Stop holds', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let removed: number;
  let sandboxStops: () => Promise<'gone' | 'unknown'>;

  beforeEach(async () => {
    removed = 0;
    flow = await createFlowHarness(KEY, {
      sandboxCalls: {
        stopRun: () => {
          const answer = sandboxStops();
          void answer.then((result) => {
            if (result === 'gone') removed += 1;
          });
          return answer;
        },
      },
    });
    sandboxStops = () => flow.sandbox.calls.stopRun();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);

  it('stores STOPPED during a visit when docker does not answer, and removes the container on a later tick', async () => {
    const run = await save(runs(), KEY, 'implement', 'running');
    run.activeAttempt = 'attempt-1';
    run.stepStartedAt = new Date(flow.app.clock.now()).toISOString();
    await storeRun(runs(), run);
    flow.dockerSilent(10 * MINUTE);

    const result = await flow.app.pipeline.stop(KEY);

    expect(result.message).not.toContain('is still running');
    const stopped = (await runs().findRun(KEY))!;
    expect(stopped.status).toBe('blocked');
    expect(storedState(stopped).reason).toEqual({ code: REASON.stopped, message: STOP_NOTE });
    expect(await documents().latestBody(KEY, 'stop_cleanup')).toBe('implement');
    await assertInvariants(flow.app);

    const reconciler = flow.app.app.get(Reconciler);
    await reconciler.reconcileAll();
    expect(await documents().latestBody(KEY, 'stop_cleanup')).toBe('implement');
    expect(removed).toBe(0);

    flow.sandbox.elapse(10 * MINUTE);
    await reconciler.reconcileAll();
    expect(removed).toBe(1);
    expect(await documents().latestBody(KEY, 'stop_cleanup')).toBe('');
    expect((await runs().findRun(KEY))?.status).toBe('blocked');
    await assertInvariants(flow.app);
  });

  it('holds a stopped subtask against the needs pass, a planner answer, the subtask port and the reconciler', async () => {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a')])}\n`);
    await flow.app.pipeline.step('implement', KEY);
    const child = (await runs().findRun(`${KEY}-a`))!;
    await documents().putDocument(child, 'repos', 'demo\n');
    await documents().putDocument(child, 'needs', 'needs:\n- zzz: something\n');
    writeRunState(child, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: REASON.stopped, message: STOP_NOTE },
    });
    await storeRun(runs(), child);
    const launched = flow.launched.length;
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue('Build it in this task.');

    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(SubtaskPort).rerun(child, ['Build it in this task.'], { by: 'planner', level: 0 });
    await flow.app.app.get(SubtaskPort).resume(child);
    await flow.tick();
    await flow.app.app.get(Reconciler).reconcileAll();

    const held = (await runs().findRun(`${KEY}-a`))!;
    expect(held.status).toBe('blocked');
    expect(storedState(held).reason?.code).toBe(REASON.stopped);
    expect(flow.launched.slice(launched)).toEqual([]);
    expect(parseSubtasks(await documents().latestBody(KEY, 'subtasks'))).toHaveLength(1);
    await assertInvariants(flow.app);
  });
});
