import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from '../result-answer';
import { remember } from '../runs.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-902';
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const FIRST = block({
  summary: ['planned'],
  plan: ['add the field - files: a.ts - proof: a.spec.ts'],
  covers: [['R1']],
});

describe('two commands for one run submitted at once', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      blocks: new BlockAgentRunner({ plan: [FIRST] }),
      realImplement: 'all',
      implementCommits: true,
    });
    flow.fastWaits();
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const submit = (type: Parameters<CommandService['submit']>[0], payload: Record<string, unknown> = {}) =>
    flow.app.app.get(CommandService).submit(type, KEY, payload);

  it('two Resume commands run one after the other and the run ends in one state', async () => {
    const first = submit('resume', { by: 'person', level: null });
    const second = submit('resume', { by: 'person', level: null });
    await Promise.allSettled([first, second]);
    await settle(flow.app);

    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(storedState(run).state).toBe('done');
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).state).toBe('done');
    await assertSettled(flow.app);
  });

  it('a Stop submitted with a Resume leaves the run in one state that every place shows', async () => {
    const resumed = submit('resume', { by: 'person', level: null });
    const stopped = submit('stop');
    await Promise.allSettled([resumed, stopped]);
    await settle(flow.app);

    const state = storedState((await flow.app.app.get(RunRepository).findRun(KEY))!).state;
    expect(['stopped', 'done']).toContain(state);
    await assertSettled(flow.app);
  });
});
