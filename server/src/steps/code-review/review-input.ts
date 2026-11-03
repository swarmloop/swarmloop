import { realpathSync } from 'fs';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { OpenedStep } from '../../pipeline/step-run';
import type { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../core/swarmloop-error';
import { readPlan } from '../plan/plan-record';
import { storedProjects } from '../prepare/checkout-path';
import type { PrepareStep } from '../prepare/prepare.step';
import { handoffSection } from '../shared/handoff';
import { mountsForStep, repoNames } from '../shared/repo-names';
import { approvedChecklist } from './code-review.prompts';

export async function repoMounts(
  runs: RunRepository,
  documents: DocumentRepository,
  root: string,
  key: string,
): Promise<SandboxMount[]> {
  const names = repoNames((await documents.latestBody(key, 'repos')) ?? '');
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
  return Boolean(run?.targetPath) && !(await documents.hasDocument(key, 'implementation'));
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
  prepare: PrepareStep,
  opened: OpenedStep,
): Promise<void> {
  const names = storedProjects(opened.run.projects);
  if (names.length === 0) {
    throw new SwarmloopError('projects is missing');
  }
  await prepare.ensureDetached(opened.run, names, opened.run.prompt, true);
  await documents.putDocument(opened.run, 'repos', `${names.join('\n')}\n`);
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
  const last = [...(await visits.listStats(opened.run.id))].reverse().find((item) => item.step === 'code-review');
  return last?.status === 'failed' || last?.status === 'blocked';
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
    .filter((item) => item.kind === 'implementation' && item.body.trim())
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
