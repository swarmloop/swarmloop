import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import { readCi } from '../shared/ci-reading';
import type { Seen } from './pipeline-report';

/** Reads the CI of every ref from the host; the host's calls are added to `calls`. A ref the host refuses to read shows nothing. */
export async function loadSeen(
  records: PipelineRef[],
  calls: HttpCallDraft[],
  host: CodeHost,
  jobs = true,
): Promise<Seen[]> {
  const loaded = await Promise.all(
    records.map(async (record) => {
      const result = await readCi(host, record, jobs);
      return {
        result,
        seen: {
          project: record.project,
          id: result.snapshot?.id ?? null,
          sha: record.sha ?? '',
          url: result.snapshot?.url ?? '',
          status: result.snapshot?.status ?? 'none',
          jobs: result.snapshot?.jobs ?? [],
          runs: result.snapshot?.runs ?? [],
          checks: result.snapshot?.checks ?? [],
          awaiting: result.snapshot?.awaiting ?? [],
        },
      };
    }),
  );
  for (const item of loaded) {
    calls.push(...item.result.httpCalls);
  }
  return loaded.map((item) => item.seen);
}
