import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StepName } from '../contract/steps';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { boot } from './prepare/prepare.step.spec-helpers';
import { StepRegistry } from './step.registry';

const KEY = 'PROJ-60';

/** What each step reports as missing on a run that has no documents. */
const BARE: [Exclude<StepName, 'done'>, string | null][] = [
  ['requirements', null],
  ['prepare', 'requirements'],
  ['research', `worktrees/${KEY}`],
  ['branch', 'repos'],
  ['plan', 'repos'],
  ['plan-improve', 'plan'],
  ['implement', 'plan'],
  ['implement-improve', 'implementation'],
  ['code-review', 'implementation'],
  ['commit', 'requirements'],
  ['merge-request', 'requirements'],
  ['pipeline', 'pipeline_ref'],
];

/** The kind a step needs before it starts, for the steps that declare it as a `start` input. */
const STARTS: [Exclude<StepName, 'done'>, string][] = [
  ['prepare', 'requirements'],
  ['branch', 'repos'],
  ['plan', 'repos'],
  ['commit', 'requirements'],
  ['merge-request', 'requirements'],
  ['pipeline', 'pipeline_ref'],
];

describe('missing input of every step', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-missing-input-'));
    app = await boot(root);
    const runs = app.get(RunRepository);
    const run = await runs.begin(KEY, 'requirements');
    run.status = 'waiting';
    await runs.saveRun(run);
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(BARE)('%s names %s when nothing is stored', async (step, expected) => {
    expect(await app.get(StepRegistry).get(step)?.missingInput(KEY, {})).toBe(expected);
  });

  it.each(STARTS)('%s no longer misses %s once it is stored, even empty', async (step, kind) => {
    const run = (await app.get(RunRepository).findRun(KEY))!;
    await app.get(DocumentRepository).putDocument(run, kind, '');
    expect(await app.get(StepRegistry).get(step)?.missingInput(KEY, {})).toBeNull();
  });
});
