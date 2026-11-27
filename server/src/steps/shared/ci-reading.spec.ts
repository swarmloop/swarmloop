import { PipelinesRefused } from '../../core/swarmloop-error';
import type { CodeHost, PipelineCheck, PipelineRef, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { ciState, noCi, readCi } from './ci-reading';

const ref: PipelineRef = { project: 'group/app', ref: 'feature/x', sha: 'head1' };
const REFUSED = 'the code host refuses to read pipelines (HTTP 403)';

function snapshot(status: PipelineCheck['status'], withCheck: boolean): PipelineSnapshot {
  const checks = withCheck
    ? [{ id: 1, name: 'test', app: '', status, durationMs: 1, url: '', summary: '', annotations: [], workflow: true }]
    : [];
  return { id: 1, status, url: '', jobs: [], runs: [], checks, awaiting: [] };
}

/** A host that answers by ref: `pipelines` gives the snapshot of a ref's commit, `ever` whether its branch ever had one. */
function stubHost(
  answers: { pipelines?: Record<string, PipelineSnapshot | null | 'refused'>; ever?: boolean | 'refused' } = {},
): CodeHost {
  return {
    readDefaultHead: () => Promise.resolve({ branch: 'main', sha: 'main1', httpCalls: [] }),
    readBranchPipeline: (read: PipelineRef) => {
      const answer = answers.pipelines?.[read.sha ?? ''] ?? null;
      return answer === 'refused'
        ? Promise.reject(new PipelinesRefused())
        : Promise.resolve({ snapshot: answer, httpCalls: [] });
    },
    readBranchHasPipeline: () =>
      answers.ever === 'refused'
        ? Promise.reject(new PipelinesRefused())
        : Promise.resolve({ found: answers.ever ?? false, httpCalls: [] }),
  } as unknown as CodeHost;
}

describe('readCi', () => {
  it('turns a refusal of the host into a reading', async () => {
    const host = stubHost({ pipelines: { head1: 'refused' } });

    await expect(readCi(host, ref)).resolves.toMatchObject({ snapshot: null, refused: true });
  });

  it('lets another failure through', async () => {
    const host = { readBranchPipeline: () => Promise.reject(new Error('boom')) } as unknown as CodeHost;

    await expect(readCi(host, ref)).rejects.toThrow('boom');
  });
});

describe('ciState', () => {
  it('reads none with the cause of a refusal', async () => {
    const host = stubHost({ pipelines: { head1: 'refused' } });

    await expect(ciState(host, ref, await readCi(host, ref))).resolves.toMatchObject({ state: 'none', cause: REFUSED });
  });

  it('reads the state of a head that has a check', async () => {
    const host = stubHost({ pipelines: { head1: snapshot('success', true) } });

    await expect(ciState(host, ref, await readCi(host, ref))).resolves.toMatchObject({ state: 'green', cause: null });
  });

  it('reads pending for a head with no pipeline on a branch that had one', async () => {
    const host = stubHost({ ever: true });

    await expect(ciState(host, ref, await readCi(host, ref))).resolves.toMatchObject({ state: 'pending' });
  });

  it('reads none for a branch that never had a pipeline', async () => {
    const host = stubHost();

    await expect(ciState(host, ref, await readCi(host, ref))).resolves.toMatchObject({ state: 'none', cause: null });
  });

  it('reads none with the cause of a refusal to read the whole branch', async () => {
    const host = stubHost({ ever: 'refused' });

    await expect(ciState(host, ref, await readCi(host, ref))).resolves.toMatchObject({ state: 'none', cause: REFUSED });
  });
});

describe('noCi', () => {
  it('is null when the head has a check, though main has none', async () => {
    const host = stubHost({ pipelines: { head1: snapshot('running', true) } });

    await expect(noCi(host, ref)).resolves.toMatchObject({ cause: null });
  });

  it('is null when main has CI, though the head shows none yet', async () => {
    const host = stubHost({ pipelines: { main1: snapshot('success', true) } });

    await expect(noCi(host, ref)).resolves.toMatchObject({ cause: null });
  });

  it('gives the cause of a refusal when the host refuses every read', async () => {
    const host = stubHost({ pipelines: { head1: 'refused', main1: 'refused' } });

    await expect(noCi(host, ref)).resolves.toMatchObject({ cause: REFUSED, refused: true });
  });

  it('gives a cause when neither main nor the head ever had a pipeline', async () => {
    const { cause, refused } = await noCi(stubHost(), ref);

    expect(cause).toContain('no pipeline was ever run');
    expect(refused).toBe(false);
  });
});
