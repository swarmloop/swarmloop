import { git } from '../../git/git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepContext } from '../base-step';
import { originProject } from './pipeline-report';
import type { Failure, Seen } from './pipeline-report';

/**
 * The loop record of a pipeline return. It is CI-only when the latest checks passed on the very content CI ran: for every
 * project with a failed job, the tree of the commit CI ran equals the tree the checks ran on. Checks run before the commit,
 * so the commits differ and the trees are compared. The job names are only carried, never interpreted.
 */
export async function pipelineReturn(
  failures: Failure[],
  seen: Seen[],
  ctx: StepContext,
  checked: Record<string, string> | null,
  root: string,
): Promise<{ reason: string; detail: { ciOnly: boolean; jobs: string[] } }> {
  const jobs = failures.map((failure) => failure.name);
  const reason = failures.map((failure) => `${failure.project} ${failure.name}`).join(',') || 'pipeline failed';
  // The repos are read only when the checks passed, so a return without a checks visit reads nothing more than before.
  const repos = checked === null ? null : await ctx.reread(ARTIFACTS.repos);
  const projects = new Set(failures.map((failure) => failure.project));
  let ciOnly = checked !== null && repos !== null && failures.length > 0;
  for (const project of projects) {
    const sha = seen.find((item) => item.project === project)?.sha;
    const tree = ciOnly && sha ? await treeOf(root, ctx.opened.run.key, repos ?? [], project, sha) : null;
    ciOnly = ciOnly && tree !== null && tree === checked?.[project];
  }
  return {
    reason: ciOnly ? `CI job ${jobs.join(', ')} failed; no check covers it` : reason,
    detail: { ciOnly, jobs },
  };
}

async function treeOf(
  root: string,
  key: string,
  repos: string[],
  project: string,
  sha: string,
): Promise<string | null> {
  for (const repo of checkedRepoNames(repos)) {
    const cwd = worktreePath(root, key, repo);
    if ((await originProject(cwd)) === project) {
      try {
        return (await git(['-C', cwd, 'rev-parse', `${sha}^{tree}`])).trim();
      } catch {
        return null;
      }
    }
  }
  return null;
}
