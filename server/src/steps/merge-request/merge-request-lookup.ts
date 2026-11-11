import { Injectable } from '@nestjs/common';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { pipelineRefs } from '../../integrations/service-context';
import { renderMergeRequest, type MergeRequestLine } from './merge-request-record';

/** Asks the code host, read-only, for the merge requests of the branches a run pushed. */
@Injectable()
export class MergeRequestLookup {
  constructor(private readonly registry: CodeHostRegistry) {}

  /** The `merge_request` body for the branches in `pipelineRef`, or null when any of them has no merge request. */
  async existing(run: { codeHost: string; startedBy: string | null }, pipelineRef: string): Promise<string | null> {
    const host = (await this.registry.forRun(run.startedBy, run.codeHost)).byName(run.codeHost);
    const records: (MergeRequestLine & { summary: string })[] = [];
    for (const ref of pipelineRefs(pipelineRef)) {
      const { record } = await host.findMergeRequest({ project: ref.project, source: ref.ref });
      if (!record) return null;
      records.push({ project: ref.project, iid: record.iid, url: record.url, draft: record.draft, summary: '' });
    }
    return records.length > 0 ? renderMergeRequest(records) : null;
  }
}
