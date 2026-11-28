import 'reflect-metadata';
import { ERROR_CODES } from '../../contract/error-codes';
import { parseSubtasks, type Subtask } from '../../contract/subtask';
import { SERVER_INSTANCE } from '../../core/server-instance';
import { RunQueriesService } from '../../api/run-queries.service';
import { DocumentRepository } from '../../history/document.repository';
import { StepStatEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { VisitRepository } from '../../history/visit.repository';
import { CommandService } from '../../pipeline/command.service';
import { SubtaskPort } from '../../pipeline/subtask-port';
import { handoffText } from '../../steps/shared/handoff';
import { createFlowHarness } from '../flow-harness';
import { save } from '../runs.spec-helpers';
import { storeRun } from '../store-run.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-912';

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

describe('an epic whose part is held when the person answers its question', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const part = async () => (await runs().findRun(`${KEY}-a`))!;
  const epicState = async () => storedState((await runs().findRun(KEY))!);
  const partStart = async () => (await documents().latestBody(`${KEY}-a`, 'part_start')) ?? '';
  const handoff = async () => handoffText(await documents().latestBody(`${KEY}-a`, 'handoff'));

  async function epicPass(): Promise<void> {
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
  }

  /** The part's step ended with `needs:`, as the step leaves it: waiting at that step, nothing committed. */
  async function needs(lines: string): Promise<void> {
    const run = await part();
    await documents().putDocument(run, 'repos', 'demo\n');
    await documents().putDocument(run, 'needs', `needs:\n${lines}\n`);
    writeRunState(run, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waiting' },
    });
    await storeRun(runs(), run);
  }

  /** The part's step ran once, as it does with a model: its next rerun is a new event. */
  async function ran(): Promise<void> {
    const run = await part();
    const now = new Date().toISOString();
    await flow.app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: run.id,
        step: run.currentStep,
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'ok',
      }),
    );
  }

  /** A person's Resume or a retry runs the part's step: a claim of this process holds it, as a drive does until it ends. */
  async function hold(): Promise<void> {
    const run = await part();
    run.ownerInstance = SERVER_INSTANCE;
    run.activeAttempt = 'attempt-1';
    writeRunState(run, { status: 'running', currentStep: 'implement' });
    await storeRun(runs(), run);
  }

  /** The drive of the part ends: the claim goes and the part waits at its step again. */
  async function endDrive(): Promise<void> {
    const run = await part();
    run.ownerInstance = null;
    run.activeAttempt = null;
    writeRunState(run, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waiting' },
    });
    await storeRun(runs(), run);
  }

  it('keeps the answer, waits on the part as running, and hands the answer down once the drive ended', async () => {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b', ['a'])])}\n`);
    await epicPass();
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await needs('- b: its result');
    await epicPass();
    await ran();
    await needs('- b: its result');
    await epicPass();
    const asked = await flow.app.app.get(RunQueriesService).flow(KEY);
    expect(asked.items).toHaveLength(1);
    const started = flow.launched.length;
    await hold();

    await flow.app.app
      .get(CommandService)
      .submit('answer', KEY, { answers: [{ kind: 'question', id: asked.items[0].id, body: 'Build it in a.' }] });
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);

    const waiting = await epicState();
    expect(waiting.state).toBe('waiting');
    expect(waiting.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
    expect(await partStart()).toContain('"type":"resume"');
    expect(await documents().latestBody(KEY, 'contract')).toMatch(/- subtask a at \S+: Build it in a\./);
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).items).toEqual([]);
    expect(flow.launched.length).toBe(started);

    const accept = jest.spyOn(flow.app.app.get(CommandService), 'accept');
    await endDrive();
    await settle(flow.app);

    expect(await partStart()).toBe('');
    expect(await handoff()).toContain('Build it in a.');
    expect(accept).toHaveBeenCalledWith('resume', `${KEY}-a`, expect.anything(), {
      idempotencyKey: expect.stringMatching(/^subtask-needs-PROJ-912-a-[0-9a-f]{64}$/),
    });
    expect(flow.launched.slice(started)).toContain(`${KEY}-a`);
    expect(parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => item.status)).toEqual([
      'running',
      'waiting',
    ]);
    await assertSettled(flow.app);
  });
});
