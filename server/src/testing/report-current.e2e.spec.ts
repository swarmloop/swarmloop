import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { FetchFailed } from '../core/swarmloop-error';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { REPORT_END, REPORT_START } from '../steps/shared/report-markers';
import { createFlowHarness } from './flow-harness';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-480';
const SOURCE = `feature/${KEY}-ship-the-field`;
const NOTES = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
const PARTS = { line: 'The field ships.', done: ['x'], worthALook: [], notes: NOTES, risk: 'low', riskReason: 'small' };

describe('the report in the merge request stays current', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
    writeFileSync(join(flow.tree, '.gitlab-ci.yml'), 'test:\n  script: [true]\n');
    git(flow.tree, ['add', '.gitlab-ci.yml']);
    git(flow.tree, ['commit', '-m', 'ci: add the workflow']);
    git(flow.tree, ['push', 'origin', SOURCE]);
    flow.fastWaits();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const body = async (): Promise<string> =>
    (await flow.host.findMergeRequest({ project: 'group/demo', source: SOURCE })).record?.summary ?? '';

  async function openRequest(): Promise<void> {
    const run = await flow.begin('merge-request');
    await flow.app.app.get(DocumentRepository).putDocument(run, 'review_report_result', JSON.stringify(PARTS));
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
  }

  const runStatus = async (): Promise<string | undefined> =>
    (await flow.app.app.get(RunRepository).findRun(KEY))?.status;

  const pass = (): void => flow.host.ci.pass(git(flow.tree, ['rev-parse', 'HEAD']));

  it('shows the wait for CI when the request opens, and the verdict and final time once the pipeline is green', async () => {
    await openRequest();
    const opened = await body();
    expect(opened.startsWith(REPORT_START)).toBe(true);
    expect(opened).toContain('## ⏳ Waiting for CI · risk: low');
    expect(opened).toContain('| ⏳ |');

    pass();
    flow.app.clock.advance(7 * 60_000);
    await flow.app.pipeline.runThrough(KEY);
    const done = await body();
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    expect(done).toContain('## ✅ Ready to merge · risk: low');
    expect(done).toContain('| 🟢 |');
    expect(done).toMatch(/\| 7 min \|/);
  });

  it('keeps the text a person wrote outside the markers', async () => {
    await openRequest();
    const written = `Template top\n\n${await body()}\n\nA person wrote this.`;
    await flow.host.updateMergeRequest('group/demo', 1, written);

    pass();
    await flow.app.pipeline.runThrough(KEY);
    const done = await body();
    expect(done.startsWith('Template top\n\n')).toBe(true);
    expect(done.endsWith(`${REPORT_END}\n\nA person wrote this.`)).toBe(true);
    expect(done).toContain('## ✅ Ready to merge');
  });

  it('goes on after a host 503 on the update, and the next step end puts the current report in the body', async () => {
    await openRequest();
    flow.host.ci.silent(git(flow.tree, ['rev-parse', 'HEAD']));
    flow.app.clock.advance(7 * 60_000);
    const update = jest.spyOn(flow.host, 'updateMergeRequest').mockRejectedValueOnce(new FetchFailed('HTTP 503'));
    await flow.app.pipeline.runThrough(KEY);
    expect(update).toHaveBeenCalledTimes(1);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('waiting');
    expect(await body()).toContain('| 0 min |');

    pass();
    for (let tick = 0; tick < 5 && (await runStatus()) !== 'done'; tick++) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
    }
    expect(await runStatus()).toBe('done');
    const final = await body();
    expect(final).toContain('## ✅ Ready to merge · risk: low');
    expect(final).not.toContain('| 0 min |');
  });
});
