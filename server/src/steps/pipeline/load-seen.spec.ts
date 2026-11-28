import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { finishedRuns, rerunJobs } from './ci-host';
import { loadSeen } from './load-seen';

const quiet: PipelineRef = { project: 'group/quiet', ref: 'feature/x', sha: 'a1' };
const passing: PipelineRef = { project: 'group/passes', ref: 'feature/x', sha: 'b2' };

const call: HttpCallDraft = {
  provider: 'gitlab',
  method: 'GET',
  url: 'https://gitlab.example/api/v4/projects',
  statusCode: 200,
  durationMs: 1,
  error: null,
};

function stubHost(): CodeHost {
  const run = { id: 7, status: 'success', url: 'https://ci/7', jobs: [] };
  return {
    readBranchPipeline: (ref: PipelineRef) =>
      ref.project === quiet.project
        ? Promise.resolve({ snapshot: null, httpCalls: [call] })
        : Promise.resolve({
            snapshot: { ...run, runs: [run], checks: [], awaiting: [] },
            httpCalls: [],
          }),
    rerunFailedJobs: () => Promise.resolve({ httpCalls: [] }),
  } as unknown as CodeHost;
}

describe('loadSeen', () => {
  it('shows nothing for a ref with no pipeline yet and its pipeline for the others', async () => {
    const seen = await loadSeen([quiet, passing], [], stubHost());

    expect(seen.map((item) => [item.project, item.status])).toEqual([
      ['group/quiet', 'none'],
      ['group/passes', 'success'],
    ]);
    expect(seen[0]).toMatchObject({ runs: [], checks: [], jobs: [], sha: 'a1' });
  });

  it('keeps the calls of every read', async () => {
    const calls: HttpCallDraft[] = [];

    await loadSeen([quiet], calls, stubHost());

    expect(calls).toEqual([call]);
  });

  it('takes a ref with no pipeline through the re-run of failed jobs without failing', async () => {
    const host = stubHost();
    const seen = await loadSeen([quiet, passing], [], host, false);

    await expect(rerunJobs(host, finishedRuns(seen), [])).resolves.toEqual([]);
  });
});
