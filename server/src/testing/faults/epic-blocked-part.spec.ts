import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { ERROR_CODES } from '../../contract/error-codes';
import { parseSubtasks } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { createFlowHarness } from '../flow-harness';
import { storeRun } from '../store-run.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-911';

describe('an epic whose subtask is blocked while its siblings go on', () => {
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
  const epic = epicMerges(() => flow, KEY);
  const state = async (key: string) => storedState((await runs().findRun(key))!);
  const statuses = async () =>
    Object.fromEntries(
      parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => [item.id, item.status]),
    );

  async function setPart(id: string, status: string, reason?: { code: string; message: string }): Promise<void> {
    const part = (await runs().findRun(`${KEY}-${id}`))!;
    writeRunState(part, { status, currentStep: 'implement', ...(reason ? { reason } : {}) });
    await storeRun(runs(), part);
  }

  it('shows the blocked part by name, keeps the siblings going and the epic waiting', async () => {
    await epic.seed(['a', 'b', 'c']);
    await setPart('a', 'blocked', { code: ERROR_CODES.CHECK_FAILED, message: 'a check failed' });

    await flow.app.pipeline.step('implement', KEY);
    await settle(flow.app);

    expect(await statuses()).toEqual({ a: 'blocked', b: 'running', c: 'running' });
    const parent = await state(KEY);
    expect(parent.state).toBe('waiting');
    expect(parent.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
    expect(parent.reason?.message).toContain('subtask a is blocked');
    expect((await flow.app.app.get(RunQueriesService).flow(`${KEY}-a`)).state).toBe('blocked');
    await assertSettled(flow.app);
  });
});
