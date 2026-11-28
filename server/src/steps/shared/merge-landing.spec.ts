import type { RunEntity } from '../../history/entities';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { MergeLanding, type LandingItem, type LandingQueue } from './merge-landing';
import type { MergedFilesRecord } from './merged-files-record';
import type { RepositoryHost } from './repository-host';

type Gate = Awaited<ReturnType<RepositoryHost['gate']>>;

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    state: 'open',
    sha: null,
    draft: false,
    head: 'h1',
    mergeability: 'clean',
    blockedBy: null,
    failing: [],
    pending: [],
    ...overrides,
  };
}

function setup(gates: Record<string, Gate>, mergeError?: Error) {
  const log: string[] = [];
  const host = {
    gate: async (_run: unknown, request: { project: string }) => gates[request.project],
    merge: async (_run: unknown, repo: string, _title: string, _request: unknown, head: string) => {
      log.push(`merge ${repo} ${head}`);
      if (mergeError) throw mergeError;
      return `sha-${repo}`;
    },
  } as unknown as RepositoryHost;
  const files = {
    record: async (_run: RunEntity, merged: Record<string, string>, target: (repo: string) => Promise<string>) => {
      log.push(`record ${JSON.stringify(merged)} on ${await target('web')}`);
    },
  } as unknown as MergedFilesRecord;
  const queue: LandingQueue = {
    target: () => ({ kind: 'branch' }),
    behind: async () => false,
    rebase: async (request) => ({ sent: true, note: `rebased ${request.repo}` }),
    refused: async (request, _head, message) => void log.push(`refused ${request.repo}: ${message}`),
    landed: async (repo, sha) => void log.push(`landed ${repo} ${sha}`),
    targetBranch: async (repo) => `main-of-${repo}`,
  };
  const item = (repos: string[], overrides: Partial<LandingItem> = {}): LandingItem => ({
    hostRun: { key: 'T1', codeHost: 'fake', startedBy: 'ada', parentRunId: null, taskId: null },
    run: { key: 'T1' } as RunEntity,
    title: 'Task one',
    requests: repos.map((repo) => ({ repo, project: repo, iid: 1, branch: `swarmloop/${repo}` })),
    merged: {},
    queue,
    ...overrides,
  });
  return { landing: new MergeLanding(host, files), item, log, queue };
}

describe('MergeLanding', () => {
  it('merges a clean gate with its head as guard and records the files before it returns merged', async () => {
    const { landing, item, log } = setup({ web: gate() });

    await expect(landing.land(item(['web']))).resolves.toEqual({ kind: 'merged', merged: { web: 'sha-web' } });

    expect(log).toEqual(['merge web h1', 'landed web sha-web', 'record {"web":"sha-web"} on main-of-web']);
  });

  it('takes the sha of a request the host already merged, with no merge call', async () => {
    const { landing, item, log } = setup({ web: gate({ state: 'merged', sha: 's9' }) });

    await expect(landing.land(item(['web']))).resolves.toEqual({ kind: 'merged', merged: { web: 's9' } });

    expect(log.some((line) => line.startsWith('merge '))).toBe(false);
  });

  it('holds a behind request as rebased and does not land the next request of the item', async () => {
    const { landing, item, log } = setup({ web: gate({ mergeability: 'behind' }), api: gate() });

    const result = await landing.land(item(['web', 'api']));

    expect(result).toEqual({
      kind: 'held',
      merged: {},
      holds: [{ repo: 'web', kind: 'rebased', note: 'rebased web' }],
    });
    expect(log).toEqual([]);
  });

  it('holds a request the target reads as behind although the host calls it clean', async () => {
    const { landing, item, queue } = setup({ web: gate() });

    const result = await landing.land(item(['web'], { queue: { ...queue, behind: async () => true } }));

    expect(result).toMatchObject({ kind: 'held', holds: [{ repo: 'web', kind: 'rebased' }] });
  });

  it('holds a rebase that was not sent as a wait with its note', async () => {
    const { landing, item, queue } = setup({ web: gate({ mergeability: 'behind' }) });
    const refusing = { ...queue, rebase: async () => ({ sent: false, note: 'rebase refused: no' }) };

    const result = await landing.land(item(['web'], { queue: refusing }));

    expect(result).toMatchObject({ kind: 'held', holds: [{ repo: 'web', kind: 'wait', note: 'rebase refused: no' }] });
  });

  it('asks for a rebase when the merge conflicts', async () => {
    const { landing, item } = setup({ web: gate() }, new MergeConflict('conflict'));

    const result = await landing.land(item(['web']));

    expect(result).toMatchObject({ kind: 'held', holds: [{ repo: 'web', kind: 'rebased' }] });
  });

  it('holds a merge the host refused as refused, after telling the queue', async () => {
    const { landing, item, log } = setup({ web: gate() }, new FetchFailed('protected branch'));

    const result = await landing.land(item(['web']));

    expect(result).toMatchObject({
      kind: 'held',
      holds: [{ repo: 'web', kind: 'refused', note: 'merge refused by the host: protected branch' }],
    });
    expect(log).toEqual(['merge web h1', 'refused web: protected branch']);
  });

  it('holds a draft request as a wait and still lands the second request of the item', async () => {
    const { landing, item } = setup({ web: gate({ draft: true }), api: gate() });

    const result = await landing.land(item(['web', 'api']));

    expect(result).toEqual({
      kind: 'held',
      merged: { api: 'sha-api' },
      holds: [{ repo: 'web', kind: 'wait', note: 'waits for its merge request to leave draft' }],
    });
  });

  it('holds failing checks as a person', async () => {
    const { landing, item } = setup({ web: gate({ failing: ['lint'] }) });

    const result = await landing.land(item(['web']));

    expect(result).toMatchObject({
      kind: 'held',
      holds: [{ kind: 'person', note: 'checks failing: lint; needs a person' }],
    });
  });

  it('skips the repositories already merged', async () => {
    const { landing, item, log } = setup({ web: gate() });

    await expect(landing.land(item(['web'], { merged: { web: 'old' } }))).resolves.toEqual({
      kind: 'merged',
      merged: { web: 'old' },
    });
    expect(log).toEqual(['record {"web":"old"} on main-of-web']);
  });

  it('adopts a merge by recording its files and asking the host nothing', async () => {
    const { landing, log, queue } = setup({});

    await landing.adopt({ key: 'T1' } as RunEntity, { web: 's1' }, (repo) => queue.targetBranch(repo));

    expect(log).toEqual(['record {"web":"s1"} on main-of-web']);
  });
});
