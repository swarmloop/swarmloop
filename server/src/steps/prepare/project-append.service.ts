import { Injectable } from '@nestjs/common';
import { RunEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { SwarmloopError } from '../../core/swarmloop-error';
import { repoNames } from '../../git/repo-names';
import { BranchCheckout } from '../shared/branch-checkout';
import { CheckoutService } from '../shared/checkout.service';
import { appendProjectNames } from './append-projects';
import { CHECKOUT_NAME, renderProjects, storedProjects } from './checkout-path';
import { PrepareStep } from './prepare.step';
import { ARTIFACTS } from '../contract/artifacts';

const PENDING = ARTIFACTS.pendingRepos.kind;

@Injectable()
export class ProjectAppendService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly prepare: PrepareStep,
    private readonly worktrees: CheckoutService,
    private readonly branches: BranchCheckout,
  ) {}

  async add(key: string, name: string): Promise<{ projects: string[]; applied: boolean }> {
    const trimmed = name.trim();
    if (!CHECKOUT_NAME.test(trimmed)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    const known = this.prepare.listProjects().projects;
    if (!known.includes(trimmed)) {
      throw new SwarmloopError(`${trimmed} is not a checkout`);
    }
    const run = await this.runs.findRun(key);
    if (!run) {
      throw new SwarmloopError(`${key} is missing`);
    }
    const current = storedProjects(run.projects);
    if (current.includes(trimmed)) {
      return { projects: current, applied: true };
    }
    if (run.status === 'running') {
      const pending = storedProjects((await this.documents.latestBody(key, PENDING)) ?? '');
      const queued = storedProjects(renderProjects([...pending, trimmed]));
      await this.documents.putDocument(run, PENDING, renderProjects(queued));
      return { projects: storedProjects(renderProjects([...current, ...queued])), applied: false };
    }
    const projects = await this.apply(run, [trimmed]);
    return { projects, applied: true };
  }

  async flush(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (!run || run.status === 'running') {
      return;
    }
    const pending = storedProjects((await this.documents.latestBody(key, PENDING)) ?? '');
    if (pending.length === 0) {
      return;
    }
    await this.apply(run, pending);
    await this.documents.putDocument(run, PENDING, '');
  }

  private async apply(run: RunEntity, incoming: string[]): Promise<string[]> {
    const current = storedProjects(run.projects);
    const { projects, added } = appendProjectNames(current, [...current, ...incoming]);
    if (added.length === 0) {
      return projects;
    }
    await this.worktrees.ensureDetached(run, added, run.prompt, false);
    const stats = await this.visits.listStats(run.id);
    const branchDone = [...stats].reverse().find((stat) => stat.step === 'branch')?.status === 'done';
    if (branchDone) {
      const requirements = await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
      const committed = (await this.documents.latestBody(run.key, ARTIFACTS.pipelineRef.kind)) !== null;
      for (const name of added) {
        await this.branches.ensure(run.key, name, requirements, committed);
      }
    }
    run.projects = renderProjects(projects);
    await this.runs.saveRun(run);
    const repos = await this.documents.latestBody(run.key, ARTIFACTS.repos.kind);
    if (repos?.trim()) {
      await this.documents.putDocument(run, ARTIFACTS.repos.kind, renderProjects([...repoNames(repos), ...added]));
    }
    const earlier = mountedNames(await this.documents.latestBody(run.key, ARTIFACTS.addedRepos.kind));
    const names = storedProjects(renderProjects([...earlier, ...added]));
    await this.documents.putDocument(run, ARTIFACTS.addedRepos.kind, `${addedNote(names)}\n`);
    return projects;
  }
}

function mountedNames(body: string | null): string[] {
  if (!body) {
    return [];
  }
  return body.split('\n').flatMap((line) => {
    const match = /^- ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) is mounted at \//.exec(line.trim());
    return match?.[1] ? [match[1]] : [];
  });
}

function addedNote(names: string[]): string {
  return [
    'Added repositories:',
    ...names.map((name) => `- ${name} is mounted at /work/${name}.`),
    "They were not in the earlier read. Write this task's contract changes there. That belongs to this task.",
  ].join('\n');
}
