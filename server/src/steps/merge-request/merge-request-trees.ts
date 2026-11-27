import { existsSync, statSync } from 'fs';
import type { AppConfig } from '../../config/env';
import { SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { git, gitDetail } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import type { CodeHost, MergeRequestRecord } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import type { RunNames } from '../shared/run-names';
import { remoteProject } from './merge-request-record';
import { ref, target } from './merge-request-target';

export interface Tree {
  repo: string;
  path: string;
  project: string;
  branch: string;
  target: string;
  existing: MergeRequestRecord | null;
  summary: string;
}

async function gitAt(repo: string, path: string, args: string[], failure: string): Promise<string> {
  try {
    return await git(['-C', path, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} ${failure}: ${gitDetail(error)}`);
  }
}

/** One tree per repository the run publishes, each checked to be a pushed feature branch of the host's own origin. */
export async function mergeRequestTrees(
  deps: { config: AppConfig; registry: CodeHostRegistry; names: RunNames },
  run: Pick<RunEntity, 'key' | 'codeHost' | 'parentRunId' | 'taskId'>,
  names: string[],
  branchOf: (repo: string) => string,
  base: string | null,
  calls: HttpCallDraft[],
  client: CodeHost,
): Promise<Tree[]> {
  const selected = deps.registry.credentials(run.codeHost);
  const host = new URL(selected.baseUrl).hostname.toLowerCase();
  const trees: Tree[] = [];
  for (const repo of names) {
    const branch = branchOf(repo);
    const path = worktreePath(root(deps.config), run.key, repo);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new SwarmloopError(`${repo} is not a worktree`);
    }
    const { origin, aimed } = await withWorktree(path, async () => {
      const current = await gitAt(repo, path, ['branch', '--show-current'], 'branch failed');
      if (current === 'main' || current === 'master') {
        throw new SwarmloopError(`${repo} branch is protected`);
      }
      if (current !== branch) {
        throw new SwarmloopError(`${repo} branch is missing`);
      }
      const remote = await ref(repo, path, `refs/remotes/origin/${branch}`);
      const head = await gitAt(repo, path, ['rev-parse', 'HEAD'], 'branch failed');
      if (!remote || remote !== head) {
        throw new SwarmloopError(`${repo} branch is not pushed`);
      }
      const project = remoteProject(await gitAt(repo, path, ['remote', 'get-url', 'origin'], 'origin failed'));
      if (project.host.toLowerCase() !== host) {
        throw new SwarmloopError(`${repo} origin is not ${selected.baseKey}`);
      }
      const to = await target(repo, path, base, deps.names.target(run, repo));
      if (to === branch) {
        throw new SwarmloopError(`${repo} target branch is the feature branch`);
      }
      return { origin: project, aimed: to };
    });
    const found = await client.findMergeRequest({ project: origin.project, source: branch });
    calls.push(...found.httpCalls);
    trees.push({ repo, path, project: origin.project, branch, target: aimed, existing: found.record, summary: '' });
  }
  return trees;
}
