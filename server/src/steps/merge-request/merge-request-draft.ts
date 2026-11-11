import { Injectable } from '@nestjs/common';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { RunEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { ARTIFACTS } from '../contract/artifacts';
import { parseMergeRequests } from './merge-request-record';

/**
 * Puts every merge request of a `merge_request` body into the given draft state, through the run's code host.
 * One that is already there is left alone. Returns the new body and the host calls; the caller stores the body.
 */
export async function setMergeRequestsDraft(
  registry: CodeHostRegistry,
  codeHost: string,
  body: string,
  draft: boolean,
): Promise<{ body: string; httpCalls: HttpCallDraft[] }> {
  const host = registry.byName(codeHost);
  const httpCalls: HttpCallDraft[] = [];
  for (const record of parseMergeRequests(body)) {
    if (record.draft !== draft) {
      httpCalls.push(...(await host.setDraft(record.project, record.iid, draft)).httpCalls);
    }
  }
  const lines = body
    .split('\n')
    .flatMap((line) =>
      line.startsWith('draft: ') ? [] : line.startsWith('url: ') ? [line, `draft: ${draft}`] : [line],
    );
  return { body: lines.join('\n'), httpCalls };
}

/** Work resumes on a run that may be `done`: its merge requests are drafts again before any of it starts. */
@Injectable()
export class MergeRequestDrafts {
  constructor(
    private readonly hosts: CodeHostRegistry,
    private readonly documents: DocumentRepository,
  ) {}

  async backToDraft(run: RunEntity): Promise<void> {
    const body = await this.documents.latestBody(run.key, ARTIFACTS.mergeRequest.kind);
    if (!body) return;
    const draft = await setMergeRequestsDraft(this.hosts, run.codeHost, body, true);
    await this.documents.putDocument(run, ARTIFACTS.mergeRequest.kind, draft.body);
  }
}
