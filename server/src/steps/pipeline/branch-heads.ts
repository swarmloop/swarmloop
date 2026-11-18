import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { HttpCallDraft } from '../../core/swarmloop-error';

/** Each ref with the commit its branch has on the host now, so the CI judged is the CI of the head and not of an older commit. */
export async function atBranchHeads(
  host: CodeHost,
  records: PipelineRef[],
  calls: HttpCallDraft[],
): Promise<PipelineRef[]> {
  const heads = await Promise.all(records.map((record) => host.readBranchHead(record)));
  for (const head of heads) {
    calls.push(...head.httpCalls);
  }
  return records.map((record, index) => ({ ...record, sha: heads[index].sha }));
}
