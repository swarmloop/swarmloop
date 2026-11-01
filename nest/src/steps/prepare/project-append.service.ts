import { Injectable } from '@nestjs/common';
import { RunEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { SwarmloopError } from '../../swarmloop-error';
import { repoNames } from '../shared/repo-names';
import { BranchService } from '../branch/branch.service';
import { appendProjectNames } from './append-projects';
import { CHECKOUT_NAME, renderProjects, storedProjects } from './checkout-path';
import { PrepareService } from './prepare.service';

const PENDING = 'pending_repos';

@Injectable()
export class ProjectAppendService {
  constructor(
    private readonly history: HistoryService,
    private readonly prepare: PrepareService,
    private readonly branch: BranchService,
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
    const run = await this.history.findRun(key);
    if (!run) {
      throw new SwarmloopError(`${key} is missing`);
    }
    const current = storedProjects(run.projects);
    if (current.includes(trimmed)) {
      return { projects: current, applied: true };
    }
    if (run.status === 'running') {
      const pending = storedProjects((await this.history.latestBody(key, PENDING)) ?? '');
      const queued = storedProjects(renderProjects([...pending, trimmed]));
      await this.history.putDocument(run, PENDING, renderProjects(queued));
      return { projects: storedProjects(renderProjects([...current, ...queued])), applied: false };
    }
    const projects = await this.apply(run, [trimmed]);
    return { projects, applied: true };
  }

  async flush(key: string): Promise<void> {
    const run = await this.history.findRun(key);
    if (!run || run.status === 'running') {
      return;
    }
    const pending = storedProjects((await this.history.latestBody(key, PENDING)) ?? '');
    if (pending.length === 0) {
      return;
    }
    await this.apply(run, pending);
    await this.history.putDocument(run, PENDING, '');
  }

  private async apply(run: RunEntity, incoming: string[]): Promise<string[]> {
    const current = storedProjects(run.projects);
    const { projects, added } = appendProjectNames(current, [...current, ...incoming]);
    if (added.length === 0) {
      return projects;
    }
    await this.prepare.ensureDetached(run, added, run.prompt, false);
    const stats = await this.history.listStats(run.id);
    const branchDone = [...stats].reverse().find((stat) => stat.step === 'branch')?.status === 'done';
    if (branchDone) {
      for (const name of added) {
        await this.branch.ensure(run.key, name);
      }
    }
    run.projects = renderProjects(projects);
    await this.history.saveRun(run);
    const repos = await this.history.latestBody(run.key, 'repos');
    if (repos?.trim()) {
      await this.history.putDocument(run, 'repos', renderProjects([...repoNames(repos), ...added]));
    }
    const earlier = mountedNames(await this.history.latestBody(run.key, 'added_repos'));
    const names = storedProjects(renderProjects([...earlier, ...added]));
    await this.history.putDocument(run, 'added_repos', `${addedNote(names)}\n`);
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
    'They were not in the earlier read. Write this task\'s contract changes there. That belongs to this task.',
  ].join('\n');
}
