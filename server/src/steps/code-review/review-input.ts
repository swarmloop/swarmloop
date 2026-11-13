import { realpathSync } from 'fs';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import { ERROR_CODES } from '../../contract/error-codes';
import { SwarmloopError } from '../../core/swarmloop-error';
import { deriveState } from '../../history/run-state';
import { readPlan } from '../plan/plan-record';
import { storedProjects } from '../../config/checkout-path';
import type { CheckoutService } from '../shared/checkout.service';
import { handoffSection } from '../shared/handoff';
import { mountsForStep, repoNames } from '../../git/repo-names';
import { approvedChecklist } from './code-review.prompts';
import { ARTIFACTS } from '../contract/artifacts';
import { renderKeep, type KeepLine } from '../shared/keep-lines';

export async function repoMounts(
  runs: RunRepository,
  documents: DocumentRepository,
  root: string,
  key: string,
): Promise<SandboxMount[]> {
  const names = repoNames((await documents.latestBody(key, ARTIFACTS.repos.kind)) ?? '');
  const run = await runs.findRun(key);
  return mountsForStep(root, key, names, run?.targetPath ?? null).map((mount) => ({
    ...mount,
    readonly: true,
  }));
}

export function pathMount(path: string): SandboxMount[] {
  return [{ hostPath: realpathSync(path), containerPath: '/work', readonly: true }];
}

export async function storedCheckout(
  runs: RunRepository,
  documents: DocumentRepository,
  key: string,
): Promise<boolean> {
  const run = await runs.findRun(key);
  return Boolean(run?.targetPath) && !(await documents.hasDocument(key, ARTIFACTS.implementation.kind));
}

export async function foreignReview(flows: FlowRepository, runId: number): Promise<boolean> {
  return !(await flows.activePhases(runId)).includes('implementation');
}

export async function foreignReviewOf(runs: RunRepository, flows: FlowRepository, key: string): Promise<boolean> {
  const run = await runs.findRun(key);
  return run ? foreignReview(flows, run.id) : false;
}

export async function detachForeign(
  documents: DocumentRepository,
  worktrees: CheckoutService,
  opened: OpenedStep,
): Promise<void> {
  const names = storedProjects(opened.run.projects);
  if (names.length === 0) {
    throw new SwarmloopError('projects is missing');
  }
  await worktrees.ensureDetached(opened.run, names, opened.run.prompt, true);
  await documents.putDocument(opened.run, ARTIFACTS.repos.kind, `${names.join('\n')}\n`);
}

export async function retrying(visits: VisitRepository, opened: OpenedStep): Promise<boolean> {
  if (opened.previousStep !== 'code-review') {
    return false;
  }
  if (['failed', 'running', 'blocked'].includes(opened.previousStatus)) {
    return true;
  }
  if (opened.previousStatus !== 'waiting') {
    return false;
  }
  // The run waited for a provider limit: the reviewers that answered keep their answers, the others run again.
  if (opened.prior && deriveState(opened.prior).reason?.code === ERROR_CODES.RUNTIME_LIMIT) {
    return true;
  }
  const last = [...(await visits.listStats(opened.run.id))].reverse().find((item) => item.step === 'code-review');
  return last?.status === 'failed' || last?.status === 'blocked';
}

/** The attempt of the code-review visit that was interrupted: its reviewer files are the only ones a recovery may read. */
export async function interruptedAttempt(visits: VisitRepository, opened: OpenedStep): Promise<string | null> {
  const last = [...(await visits.listStats(opened.run.id))].reverse().find((item) => item.step === 'code-review');
  return last?.attemptId ?? null;
}

export function approvedPlan(requirements: string): string {
  const plan = readPlan(requirements);
  if (!plan || plan.decision !== 'approve' || plan.items.length === 0) {
    return '';
  }
  return approvedChecklist(plan.items);
}

export function fixNotes(
  documents: { kind: string; body: string }[],
  handoff: string | null,
): { implement: string; reviewed: string } {
  const written = documents
    .filter((item) => item.kind === ARTIFACTS.implementation.kind && item.body.trim())
    .map((item) => item.body.trim());
  const implementWhat = written.length >= 2 ? written[written.length - 2] : (written.at(-1) ?? '');
  const reviewWhat = written.length >= 2 ? (written.at(-1) ?? '') : '';
  const same = reviewWhat.length > 0 && reviewWhat === implementWhat;
  return {
    implement: passNote(implementWhat, handoffSection(handoff, 'implement')),
    reviewed: passNote(same ? '' : reviewWhat, handoffSection(handoff, 'implement-improve')),
  };
}

function passNote(what: string, why: string): string {
  const parts = [what.trim() ? `What was done:\n${what.trim()}` : '', why.trim() ? `Why:\n${why.trim()}` : ''];
  return parts.filter((part) => part.length > 0).join('\n');
}

const KEEP_CHECK =
  'Check each line against the merged diff. A capability the diff breaks is a return that names the capability.';

/** The `Keep` section of a split parent's final review: the kept capabilities and how to check them. Left out with no lines. */
export function withKeep(
  sections: { heading: string; body: string }[],
  keep: KeepLine[] | null,
): { heading: string; body: string }[] {
  return keep?.length ? [...sections, { heading: 'Keep', body: `${renderKeep(keep)}\n\n${KEEP_CHECK}` }] : sections;
}
