import { realpathSync } from 'fs';
import type { AppConfig } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import { root } from '../../history/run-paths';
import { assertInsideWork, workRoots } from '../../sandbox/allowed-path';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { StepContext } from '../base-step';
import type { CheckoutService } from '../shared/checkout.service';
import { checkoutFingerprint, gateCounts, worktreesFingerprint } from '../shared/gate';
import { returnedNotes } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import { reviewDiffSection } from './review-diff';
import { detachForeign, foreignReview, interruptedAttempt, pathMount, repoMounts, retrying } from './review-input';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { DocumentDraft } from '../../history/visit';
import type { Opinion } from './code-review-record';
import { reviewExchanges, type Exchange } from './review-exchange';
import type { Reviewer } from './reviewer';
import { selectReviewers } from './review-select';

/** What the preparation reads. */
export interface PrepareDeps {
  runs: RunRepository;
  flows: FlowRepository;
  documents: DocumentRepository;
  visits: VisitRepository;
  worktrees: CheckoutService;
  config: AppConfig;
}

/** What the review goes on with: the checkout, the diff, the earlier answers, and which reviewers run. */
interface Preparation {
  requirements: string;
  thirdParty: boolean;
  mounts: SandboxMount[];
  fresh: boolean;
  retry: boolean;
  exchanges: Map<string, Exchange>;
  returned: string | null;
  diff: Awaited<ReturnType<typeof reviewDiffSection>>;
  fingerprint: string;
  kept: Opinion[];
  pending: Reviewer[];
  recovered: DocumentDraft[];
}

/** Everything before the first reviewer or report launches: the worktrees, the diff, and which reviewers run. */
export async function prepareReview(deps: PrepareDeps, notes: string | null, ctx: StepContext): Promise<Preparation> {
  const { opened, options } = ctx;
  const { key } = opened.run;
  const checkout = options.path ?? (notes?.trim() ? null : opened.run.targetPath);
  let thirdParty = Boolean(checkout);
  if (!thirdParty && !notes?.trim()) {
    if (!(await foreignReview(deps.flows, opened.run.id))) {
      throw new SwarmloopError('implementation is missing');
    }
    await detachForeign(deps.documents, deps.worktrees, opened);
    thirdParty = true;
  }
  if (checkout) {
    assertInsideWork(checkout, workRoots(deps.config));
    opened.run.targetPath = realpathSync(checkout);
  }
  const requirements = ((await ctx.reread(ARTIFACTS.requirements)) ?? '').trim() || opened.run.prompt || '';
  if (!thirdParty && !requirements.trim()) {
    throw new SwarmloopError('requirements is missing');
  }
  const mounts = checkout ? pathMount(checkout) : await repoMounts(deps.runs, deps.documents, root(deps.config), key);
  const fresh = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim() === 'review';
  const retry = fresh ? false : await retrying(deps.visits, opened);
  const attemptId = retry ? await interruptedAttempt(deps.visits, opened) : null;
  const returned = await returnedNotes(deps.documents, opened.run.id);
  const diff = await reviewDiffSection(mounts, [], opened.run.prompt);
  const fingerprint = await (opened.run.targetPath ? checkoutFingerprint : worktreesFingerprint)(
    mounts.map((mount) => mount.hostPath),
  );
  const { kept, pending, recovered } = await selectReviewers(deps.documents, root(deps.config), {
    key,
    fresh,
    retry,
    attemptId,
    counts: (kind) => gateCounts(deps.documents, opened.run, kind, fingerprint),
  });
  return {
    requirements,
    thirdParty,
    mounts,
    fresh,
    retry,
    exchanges: await reviewExchanges(deps.documents, opened.run.id, returned),
    returned,
    diff,
    fingerprint,
    kept,
    pending,
    recovered,
  };
}
