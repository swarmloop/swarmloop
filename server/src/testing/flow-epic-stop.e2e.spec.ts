import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RunCommandsService } from '../api/run-commands.service';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON, STOP_NOTE } from '../contract/run-state';
import type { Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { CommandEntity, type RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { save } from './runs.spec-helpers';

const KEY = 'PROJ-480';

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

describe('a person’s Stop and Resume of an epic', () => {
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
  const commands = () => flow.app.app.get(RunCommandsService);
  const child = async (id: string) => (await runs().findRun(`${KEY}-${id}`))!;

  async function epicWithTasks(): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(
      parent,
      'subtasks',
      `${JSON.stringify([task('a'), task('b'), task('c'), task('d')])}\n`,
    );
    await flow.app.pipeline.step('implement', KEY);
  }

  async function setState(
    run: RunEntity,
    status: string,
    reason?: { code: string; message: string; retryAt?: string },
  ): Promise<void> {
    writeRunState(run, { status, currentStep: 'implement', ...(reason ? { reason } : {}) });
    await runs().saveRun(run);
  }

  it('stops a running task and one waiting on an outage, resumes those, and leaves a task the person stopped before and a plain waiting one', async () => {
    await epicWithTasks();
    const running = await child('a');
    running.activeAttempt = 'attempt-1';
    await setState(running, 'running');
    await setState(await child('b'), 'waiting', {
      code: ERROR_CODES.HOST_UNAVAILABLE,
      message: 'The host is down.',
      retryAt: new Date(flow.app.clock.now() + 60 * 60_000).toISOString(),
    });
    await setState(await child('d'), 'waiting');
    await setState(await child('c'), 'blocked', { code: REASON.stopped, message: STOP_NOTE });
    await runs().saveRun((await runs().findRun(KEY))!);

    await commands().stop(KEY);
    await flow.tick();

    expect(await documents().latestBody(KEY, 'epic_stopped_tasks')).toBe(`${KEY}-a\n${KEY}-b`);
    expect(storedState(await child('a')).reason?.code).toBe(REASON.stopped);
    expect(storedState(await child('b')).reason?.code).toBe(REASON.stopped);
    expect(storedState(await child('c')).reason?.code).toBe(REASON.stopped);
    expect(storedState(await child('d')).reason?.code).not.toBe(REASON.stopped);
    await assertInvariants(flow.app);

    const record = await documents().latestDocument(KEY, 'epic_stopped_tasks');
    await commands().resume(KEY);
    await flow.app.pipeline.whenIdle(KEY);
    await flow.tick();

    expect(await documents().latestBody(KEY, 'epic_stopped_tasks')).toBe('');
    const resumed = await flow.app.app
      .get(DataSource)
      .getRepository(CommandEntity)
      .find({ where: { type: 'resume' } });
    const keys = resumed.map((command) => command.idempotencyKey).filter((key) => key?.startsWith('epic-resume-'));
    expect(keys.sort()).toEqual([`epic-resume-${KEY}-a-${record?.id}`, `epic-resume-${KEY}-b-${record?.id}`]);
    expect(storedState(await child('c')).reason?.code).toBe(REASON.stopped);
    await assertInvariants(flow.app);
  });

  it('does not let a machine resume of an epic resume the tasks a person stopped', async () => {
    await epicWithTasks();
    await setState(await child('c'), 'blocked', { code: REASON.stopped, message: STOP_NOTE });
    const parent = (await runs().findRun(KEY))!;
    await documents().putDocument(parent, 'epic_stopped_tasks', `${KEY}-c`);

    await commands().resume(KEY, undefined, { by: 'machine', level: null });
    await flow.app.pipeline.whenIdle(KEY);

    expect(await documents().latestBody(KEY, 'epic_stopped_tasks')).toBe(`${KEY}-c`);
    expect(storedState(await child('c')).reason?.code).toBe(REASON.stopped);
    await assertInvariants(flow.app);
  });
});
