import { PipelinesRefused, type HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { finishedRuns, rerunJobs } from './ci-host';
import { loadSeen } from './load-seen';

const refused: PipelineRef = { project: 'group/refuses', ref: 'feature/x', sha: 'a1' };
const passing: PipelineRef = { project: 'group/passes', ref: 'feature/x', sha: 'b2' };

const call: HttpCallDraft = {
  provider: 'gitlab',
  method: 'GET',
  url: 'https://gitlab.example/api/v4/projects',
  statusCode: 403,
  durationMs: 1,
  error: null,
};

function stubHost(): CodeHost {
  const run = { id: 7, status: 'success', url: 'https://ci/7', jobs: [] };
  return {
    readBranchPipeline: (ref: PipelineRef) =>
      ref.project === refused.project
        ? Promise.reject(new PipelinesRefused([call]))
        : Promise.resolve({
            snapshot: { ...run, runs: [run], checks: [], awaiting: [] },
            httpCalls: [],
          }),
    rerunFailedJobs: () => Promise.resolve({ httpCalls: [] }),
  } as unknown as CodeHost;
}

describe('loadSeen', () => {
  it('shows nothing for a ref the host refuses to read and its pipeline for the others', async () => {
    const seen = await loadSeen([refused, passing], [], stubHost());

    expect(seen.map((item) => [item.project, item.status])).toEqual([
      ['group/refuses', 'none'],
      ['group/passes', 'success'],
    ]);
    expect(seen[0]).toMatchObject({ runs: [], checks: [], jobs: [], sha: 'a1' });
  });

  it('keeps the calls of a refused read', async () => {
    const calls: HttpCallDraft[] = [];

    await loadSeen([refused], calls, stubHost());

    expect(calls).toEqual([call]);
  });

  it('takes a refused ref through the re-run of failed jobs without failing', async () => {
    const host = stubHost();
    const seen = await loadSeen([refused, passing], [], host, false);

    await expect(rerunJobs(host, finishedRuns(seen), [])).resolves.toEqual([]);
  });
});
