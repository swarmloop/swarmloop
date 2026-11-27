import type { RunRepository } from '../../history/run.repository';
import type { EventRepository } from '../../history/event.repository';
import type { StepResult } from '../contract/step-contract';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import { git } from '../../git/git';
import { checkedRepoNames, hasCi, worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { originProject, type Seen } from './pipeline-report';
import { ARTIFACTS } from '../contract/artifacts';
import { automaticRebase } from './pipeline-rebase';
import { waitForCi } from './ci-not-started';

/** Only the trigger is automatic. Rebase itself is the action used by the API button. */
export async function missingPipeline(input: {
  ctx: StepContext;
  runs: RunRepository;
  events: EventRepository;
  rebase: Pick<RunRebase, 'rebase'>;
  halted: () => boolean;
  root: string;
  limit: number;
  host: CodeHost;
  records: PipelineRef[];
  seen: Seen[];
  missing: string[];
}): Promise<StepResult> {
  const { ctx, runs, events, rebase, host, records, seen } = input;
  const run = ctx.opened.run;
  const notes = [input.missing.map((repo) => `${repo} CI did not start`).join(', ')];
  const conflicts: PipelineRef[] = [];
  const conflictReasons: string[] = [];
  const unexplained: PipelineRef[] = [];
  let closed = false;
  for (const ref of records.filter((ref) =>
    seen.some((item) => item.project === ref.project && item.runs.length === 0),
  )) {
    notes.push(`project: ${ref.project}`, `ref: ${ref.ref}`, `sha: ${ref.sha ?? 'unknown'}`);
    const diagnosis = await host.diagnoseMissingPipeline(ref);
    if (!diagnosis.code) unexplained.push(ref);
    ctx.calls.push(...diagnosis.httpCalls);
    if (diagnosis.reason) notes.push(diagnosis.reason);
    if (diagnosis.code === 'merge-conflict') {
      conflicts.push(ref);
      if (diagnosis.reason) conflictReasons.push(diagnosis.reason);
    }
    if (diagnosis.code === 'closed') closed = true;
  }
  const end = (outcome: 'failed' | 'blocked', detail?: string): StepResult => {
    const line = `${ctx.opened.startedAt} ${[...notes, detail].filter(Boolean).join('\n')}`;
    return {
      route:
        outcome === 'blocked' ? { to: 'block', reason: line } : { to: 'fail', error: { code: outcome, message: line } },
      summary: line,
      outputs: [],
      visit: { status: outcome },
    };
  };
  if (closed) return end('blocked');
  if (conflicts.length === 0) {
    return unexplained.length === 0 ? end('failed') : waitForCi({ ctx, events, host, refs: unexplained, notes });
  }
  if (run.attemptsPipeline >= input.limit) {
    return end('blocked', `automatic rebase limit reached after ${run.attemptsPipeline} automatic rebases`);
  }
  const changed = await changedWorktree(input.root, run.key, ctx, records);
  if (changed) return end('blocked', changed);
  run.attemptsPipeline += 1;
  await events.recordLoop(run, 'pipeline', run.attemptsPipeline, 'merge conflict: automatic rebase');
  return {
    route: { to: 'wait', reason: 'automatic rebase' },
    summary: `${ctx.opened.startedAt} automatic rebase\n${notes.join('\n')}`,
    outputs: [{ artifact: ARTIFACTS.pipelineLog, value: `result: rebase\n${notes.join('\n')}\n` }],
    visit: { status: 'waiting' },
    afterClose: automaticRebase({ ctx, runs, rebase, halted: input.halted, hostConflict: conflictReasons.join('\n') }),
  };
}

async function changedWorktree(
  root: string,
  key: string,
  ctx: StepContext,
  refs: PipelineRef[],
): Promise<string | null> {
  const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
  for (const repo of names) {
    const cwd = worktreePath(root, key, repo);
    const unchanged = await withWorktree(cwd, async () => {
      const project = await originProject(cwd);
      const ref = refs.find((ref) => ref.project === project);
      const [head, branch, dirty] = await Promise.all([
        git(['-C', cwd, 'rev-parse', 'HEAD']),
        git(['-C', cwd, 'branch', '--show-current']),
        git(['-C', cwd, 'status', '--porcelain']),
      ]);
      return Boolean(ref?.sha && ref.sha === head && ref.ref === branch && !dirty);
    });
    if (!unchanged) {
      return `${repo}: published SHA, local branch or working files changed; automatic rebase was blocked`;
    }
  }
  return null;
}

/**
 * Repo names that have a workflow file and no run. A repository whose project is known and is not watched (the run did
 * not change it) is left out. Null when the repo list is missing.
 */
export async function missingRuns(ctx: StepContext, root: string, seen: Seen[]): Promise<string[] | null> {
  const withCi = await reposWithCi(ctx, root);
  if (!withCi) {
    return null;
  }
  const missing: string[] = [];
  for (const { name, project } of withCi) {
    const run = project ? seen.find((item) => item.project === project) : undefined;
    if (project && !run) {
      continue;
    }
    if (!run || run.runs.length === 0) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * The origin projects of the run's checked repositories whose tree has a CI file, read the way `missingRuns` reads
 * them. Empty when the repo list is missing or unreadable.
 */
export async function ciFileProjects(ctx: StepContext, root: string): Promise<Set<string>> {
  const projects = (await reposWithCi(ctx, root))?.flatMap(({ project }) => (project ? [project] : [])) ?? [];
  return new Set(projects);
}

/**
 * The run's checked repositories whose tree has a CI file, with the origin project of each (null when it has none).
 * Null when the repo list is missing or unreadable.
 */
async function reposWithCi(ctx: StepContext, root: string): Promise<{ name: string; project: string | null }[] | null> {
  const lines = await ctx.reread(ARTIFACTS.repos);
  if (!lines || lines.length === 0) {
    return null;
  }
  let names: string[];
  try {
    names = checkedRepoNames(lines);
  } catch {
    return null;
  }
  const found: { name: string; project: string | null }[] = [];
  for (const name of names) {
    const dir = worktreePath(root, ctx.opened.run.key, name);
    if (hasCi(dir)) {
      found.push({ name, project: await withWorktree(dir, () => originProject(dir)) });
    }
  }
  return found;
}
