import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import { setMergeRequestsDraft } from '../merge-request/merge-request-draft';
import { parseMergeRequests } from '../merge-request/merge-request-record';

export async function hasDraft(ctx: StepContext): Promise<boolean> {
  const body = await ctx.reread(ARTIFACTS.mergeRequest);
  return body ? parseMergeRequests(body).some((record) => record.draft) : false;
}

/** A run is `done` only with its merge requests ready for review. */
export async function markReady(ctx: StepContext, registry: CodeHostRegistry): Promise<void> {
  const body = await ctx.reread(ARTIFACTS.mergeRequest);
  if (!body) {
    return;
  }
  const ready = await setMergeRequestsDraft(registry, ctx.opened.run.codeHost, body, false);
  ctx.calls.push(...ready.httpCalls);
  await ctx.write(ARTIFACTS.mergeRequest, ready.body);
}
