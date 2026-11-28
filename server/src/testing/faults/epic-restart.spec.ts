import 'reflect-metadata';
import { parseSubtasks } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { SubtaskOps } from '../../steps/shared/subtask-ops';
import { createFlowHarness } from '../flow-harness';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-912';

describe('a server restart in an epic', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  const epic = epicMerges(() => flow, KEY);

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true, taskWorktrees: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const tasks = async () =>
    parseSubtasks((await flow.app.app.get(DocumentRepository).latestBody(KEY, 'subtasks')) ?? '');
  const statuses = async () => Object.fromEntries((await tasks()).map((item) => [item.id, item.status]));

  it('while a subtask merges into the epic branch: the host merged it and the record was lost, so the next process records that merge and merges nothing twice', async () => {
    await epic.seed(['a', 'b']);
    const first = await epic.deliver('a');
    // The pass was cut after the host took the merge and before the merge was recorded.
    await flow.app.app.get(RunRepository).begin(KEY, 'implement');
    await flow.host.mergeMergeRequest('demo', first.iid);
    const landed = flow.host.merged.get(first.iid);

    await flow.restart();
    // After the restart the part is on top of the epic branch: its own merge is the only move of the branch, so no move is queued for it.
    jest.spyOn(flow.app.app.get(SubtaskOps), 'behindTip').mockResolvedValue(null);
    await settle(flow.app);
    await flow.tick();
    await settle(flow.app);

    expect([...flow.host.merged.keys()]).toEqual([first.iid]);
    expect((await tasks()).find((item) => item.id === 'a')?.merged).toEqual({ demo: landed });
    expect((await statuses()).a).toBe('merged');
    await assertSettled(flow.app);
  });

  it('while the parent’s pass runs: the next process takes the cut pass over and the epic waits for its parts', async () => {
    await epic.seed(['a', 'b']);
    await flow.app.app.get(RunRepository).begin(KEY, 'implement');

    await flow.restart();
    await settle(flow.app);
    await flow.tick();
    await settle(flow.app);

    expect(await statuses()).toEqual({ a: 'running', b: 'running' });
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('waiting');
    await assertSettled(flow.app);
  });
});
