import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { baseBranch, originRef } from '../../git/base-ref';
import { git } from '../../git/git';
import { fetchBranch } from '../../git/rebase';
import type { RebaseHosts } from '../../git/rebase/types';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { HostUnavailable } from '../../core/swarmloop-error';
import { automaticRebase } from './pipeline-rebase';
import { originProject, type Failure } from './pipeline-report';

export interface DefaultBranchDeps {
  runs: RunRepository;
  rebase: Pick<RunRebase, 'rebase'>;
  halted: (key: string) => boolean;
  hosts: (run: RunEntity) => Promise<RebaseHosts>;
  root: string;
}

/** Every test file has one of these name shapes, whatever the language or the tool. */
const TEST_NAMES = [/\.(test|spec)\.\w+$/, /^test_.+\.\w+$/, /_test\.\w+$/];
const MAX_PATHS = 50;

/** The test file paths a log names, as it wrote them. */
export function testPaths(trace: string): string[] {
  const found = new Set<string>();
  for (const match of trace.matchAll(/[\w@.+/-]+/g)) {
    const path = match[0].replace(/\.+$/, '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!path.includes('..') && TEST_NAMES.some((pattern) => pattern.test(name))) found.add(path);
  }
  return [...found].slice(0, MAX_PATHS);
}

async function has(cwd: string, rev: string, path: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'cat-file', '-e', `${rev}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** A path as a log wrote it may carry the runner's directories in front: the longest tail that is a file tells where it is. The test file when it is on `base` only. */
async function onlyOnDefault(cwd: string, base: string, path: string): Promise<string | null> {
  const parts = path.replace(/^\.?\/+/, '').split('/');
  for (let at = 0; at < parts.length; at += 1) {
    const tail = parts.slice(at).join('/');
    if (await has(cwd, 'HEAD', tail)) return null;
    if (await has(cwd, base, tail)) return tail;
  }
  return null;
}

/** The default branch ref of a worktree, fetched. The prompt's `branch:` line, else the remote's HEAD, else main or master. */
async function fetchDefault(
  deps: DefaultBranchDeps,
  run: RunEntity,
  cwd: string,
  repo: string,
): Promise<string | null> {
  const named = baseBranch(run.prompt);
  const remoteHead = await git(['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  const candidates = named ? [named] : [remoteHead.replace(/^origin\//, ''), 'main', 'master'].filter(Boolean);
  const hosts = await deps.hosts(run);
  for (const name of candidates) {
    if (await fetchBranch(cwd, repo, name, hosts)) return originRef(name);
  }
  return null;
}

/**
 * CI tests the branch merged with today's default branch, so a failing test file that only the default branch has is
 * fixed by a rebase, not by an agent. Once per head of the default branch. Null when no such file is named.
 */
export async function defaultBranchTests(
  deps: DefaultBranchDeps,
  ctx: StepContext,
  failures: Failure[],
): Promise<StepResult | null> {
  if (failures.every((item) => testPaths(item.trace).length === 0)) return null;
  const run = ctx.opened.run;
  const history = JSON.parse((await ctx.reread(ARTIFACTS.pipelineRebases)) ?? '[]') as string[];
  for (const repo of await worktreeNames(ctx)) {
    const cwd = worktreePath(deps.root, run.key, repo);
    const project = await originProject(cwd);
    const paths = failures.filter((item) => item.project === project).flatMap((item) => testPaths(item.trace));
    if (!project || paths.length === 0) continue;
    const base = await fetchDefaultSafely(deps, run, cwd, repo);
    if (!base) continue;
    const source = `default@${await git(['-C', cwd, 'rev-parse', base])}`;
    if (history.includes(source)) continue;
    const missing: string[] = [];
    for (const path of paths) {
      const found = await onlyOnDefault(cwd, base, path);
      if (found && !missing.includes(found)) missing.push(found);
    }
    if (missing.length === 0) continue;
    const notes = [
      `project: ${project}`,
      `default branch: ${base}`,
      ...missing.map((path) => `test only on it: ${path}`),
    ];
    return {
      route: { to: 'wait', reason: 'automatic rebase' },
      summary: `${ctx.opened.startedAt} automatic rebase onto ${base}\n${notes.join('\n')}`,
      outputs: [
        { artifact: ARTIFACTS.pipelineRebases, value: JSON.stringify([...history, source]) },
        { artifact: ARTIFACTS.pipelineLog, value: `result: rebase\n${notes.join('\n')}\n` },
      ],
      visit: { status: 'waiting' },
      afterClose: automaticRebase({ ctx, runs: deps.runs, rebase: deps.rebase, halted: () => deps.halted(run.key) }),
    };
  }
  return null;
}

/** The repos of the run; none when the list is missing or invalid. */
async function worktreeNames(ctx: StepContext): Promise<string[]> {
  const lines = await ctx.reread(ARTIFACTS.repos);
  try {
    return lines && lines.length > 0 ? checkedRepoNames(lines) : [];
  } catch {
    return [];
  }
}

/** A host that is down is a wait; any other reason the default branch cannot be read leaves the failure to the normal return. */
async function fetchDefaultSafely(
  deps: DefaultBranchDeps,
  run: RunEntity,
  cwd: string,
  repo: string,
): Promise<string | null> {
  try {
    return await fetchDefault(deps, run, cwd, repo);
  } catch (error) {
    if (error instanceof HostUnavailable) throw error;
    return null;
  }
}
