import { HostUnavailable } from '../../core/swarmloop-error';
import type { CodeHost, PipelineCheck, PipelineRef, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { ciState, projectHasCi, readCi } from './ci-reading';

const ref: PipelineRef = { project: 'group/app', ref: 'feature/x', sha: 'head1' };

function snapshot(status: PipelineCheck['status'], withCheck: boolean): PipelineSnapshot {
  const checks = withCheck
    ? [{ id: 1, name: 'test', app: '', status, durationMs: 1, url: '', summary: '', annotations: [], workflow: true }]
    : [];
  return { id: 1, status, url: '', jobs: [], runs: [], checks, awaiting: [] };
}

/** A host with scripted answers. A pipeline read on a host with CI off fails, as the rule must never ask it. */
function stubHost(answers: { ci?: boolean; pipeline?: PipelineSnapshot | null; ever?: boolean } = {}): CodeHost {
  return {
    ciEnabled: () => Promise.resolve(answers.ci ?? true),
    readBranchPipeline: () =>
      answers.ci === false
        ? Promise.reject(new Error('a pipeline of a project without CI was read'))
        : Promise.resolve({ snapshot: answers.pipeline ?? null, httpCalls: [] }),
    readBranchHasPipeline: () => Promise.resolve({ found: answers.ever ?? false, httpCalls: [] }),
  } as unknown as CodeHost;
}

describe('projectHasCi', () => {
  it.each([true, false])('is the answer of the host: %s', async (answer) => {
    await expect(projectHasCi(stubHost({ ci: answer }), 'group/app')).resolves.toBe(answer);
  });

  it('passes the wait of a host that cannot answer on', async () => {
    const outage = new HostUnavailable('gitlab.example', 'HTTP 403', '2030-01-01T00:00:00.000Z');
    const host = { ciEnabled: () => Promise.reject(outage) } as unknown as CodeHost;

    await expect(projectHasCi(host, 'group/app')).rejects.toBe(outage);
  });
});

describe('readCi', () => {
  it('gives the snapshot of the ref and the calls of the read', async () => {
    const host = stubHost({ pipeline: snapshot('success', true) });

    await expect(readCi(host, ref)).resolves.toMatchObject({ snapshot: { status: 'success' }, httpCalls: [] });
  });

  it('lets a failure of the read through', async () => {
    const host = { readBranchPipeline: () => Promise.reject(new Error('boom')) } as unknown as CodeHost;

    await expect(readCi(host, ref)).rejects.toThrow('boom');
  });
});

describe('ciState', () => {
  it('reads none for a project whose host reports no CI, without reading a pipeline', async () => {
    await expect(ciState(stubHost({ ci: false }), ref)).resolves.toMatchObject({ state: 'none', snapshot: null });
  });

  it.each([
    ['success', 'green'],
    ['failed', 'red'],
    ['canceled', 'red'],
    ['running', 'pending'],
  ] as const)('reads %s of a head that has a check as %s', async (status, state) => {
    const host = stubHost({ pipeline: snapshot(status, true) });

    await expect(ciState(host, ref)).resolves.toMatchObject({ state, snapshot: { status } });
  });

  it('reads pending for a head with no pipeline on a branch that had one', async () => {
    await expect(ciState(stubHost({ ever: true }), ref)).resolves.toMatchObject({ state: 'pending' });
  });

  it('reads none for a head with no pipeline on a branch that never had one (CI only for merge requests)', async () => {
    await expect(ciState(stubHost(), ref)).resolves.toMatchObject({ state: 'none' });
  });

  it('passes the wait of a host that cannot answer on', async () => {
    const outage = new HostUnavailable('gitlab.example', 'HTTP 403', '2030-01-01T00:00:00.000Z');
    const host = { ciEnabled: () => Promise.reject(outage) } as unknown as CodeHost;

    await expect(ciState(host, ref)).rejects.toBe(outage);
  });
});
