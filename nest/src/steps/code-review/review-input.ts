import { realpathSync } from 'fs';
import { HistoryService } from '../../history/history.service';
import { OpenedStep } from '../../pipeline/step-run';
import { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../swarmloop-error';
import { storedProjects } from '../prepare/checkout-path';
import { PrepareService } from '../prepare/prepare.service';
import { mountsForStep, repoNames } from '../shared/repo-names';

export async function repoMounts(history: HistoryService, key: string): Promise<SandboxMount[]> {
  const names = repoNames((await history.latestBody(key, 'repos')) ?? '');
  const run = await history.findRun(key);
  return mountsForStep(history.root(), key, names, run?.targetPath ?? null).map((mount) => ({ ...mount, readonly: true }));
}

export function pathMount(path: string): SandboxMount[] {
  return [{ hostPath: realpathSync(path), containerPath: '/work', readonly: true }];
}

export async function storedCheckout(history: HistoryService, key: string): Promise<boolean> {
  const run = await history.findRun(key);
  return Boolean(run?.targetPath) && !(await history.hasDocument(key, 'implementation'));
}

export async function foreignReview(history: HistoryService, runId: number): Promise<boolean> {
  return !(await history.activePhases(runId)).includes('implementation');
}

export async function foreignReviewOf(history: HistoryService, key: string): Promise<boolean> {
  const run = await history.findRun(key);
  return run ? foreignReview(history, run.id) : false;
}

export async function detachForeign(history: HistoryService, prepare: PrepareService, opened: OpenedStep): Promise<void> {
  const names = storedProjects(opened.run.projects);
  if (names.length === 0) {
    throw new SwarmloopError('projects is missing');
  }
  await prepare.ensureDetached(opened.run, names, opened.run.prompt, true);
  await history.putDocument(opened.run, 'repos', `${names.join('\n')}\n`);
}

export async function retrying(history: HistoryService, opened: OpenedStep): Promise<boolean> {
  if (opened.previousStep !== 'code-review') {
    return false;
  }
  if (['failed', 'running', 'blocked'].includes(opened.previousStatus)) {
    return true;
  }
  if (opened.previousStatus !== 'waiting') {
    return false;
  }
  const last = [...(await history.listStats(opened.run.id))].reverse().find((item) => item.step === 'code-review');
  return last?.status === 'failed' || last?.status === 'blocked';
}
