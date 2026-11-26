import 'reflect-metadata';
import { parseSubtasks } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { SubtaskPort } from '../../pipeline/subtask-port';
import { createFlowHarness } from '../flow-harness';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-913';

describe('a subtask’s end and the parent’s pass write the same run at once', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  const epic = epicMerges(() => flow, KEY);

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true, taskWorktrees: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('keeps the part’s merge and the pass’s own change: the part merges once and the epic goes on waiting for the other part', async () => {
    await epic.seed(['a', 'b']);
    const first = await epic.deliver('a');

    await Promise.all([flow.app.pipeline.startDetached(KEY), flow.app.app.get(SubtaskPort).notifyParent(`${KEY}-a`)]);
    await settle(flow.app);
    await flow.tick();
    await settle(flow.app);

    const tasks = parseSubtasks((await flow.app.app.get(DocumentRepository).latestBody(KEY, 'subtasks')) ?? '');
    expect(Object.fromEntries(tasks.map((item) => [item.id, item.status]))).toEqual({ a: 'merged', b: 'running' });
    expect([...flow.host.merged.keys()]).toEqual([first.iid]);
    const parent = storedState((await flow.app.app.get(RunRepository).findRun(KEY))!);
    expect(parent.state).toBe('waiting');
    await assertSettled(flow.app);
  });
});
