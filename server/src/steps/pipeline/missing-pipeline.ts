import type { RunRepository } from '../../history/run.repository';
import type { EventRepository } from '../../history/event.repository';
import type { StepResult } from '../contract/step-contract';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import { git } from '../../git/git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { originProject, type Seen } from './pipeline-report';
import { ARTIFACTS } from '../contract/artifacts';

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
  let closed = false;
  for (const ref of records.filter((ref) =>
    seen.some((item) => item.project === ref.project && item.status === 'none'),
  )) {
    notes.push(`project: ${ref.project}`, `ref: ${ref.ref}`, `sha: ${ref.sha ?? 'unknown'}`);
    const diagnosis = await host.diagnoseMissingPipeline?.(ref);
    if (!diagnosis) continue;
    ctx.calls.push(...diagnosis.httpCalls);
    if (diagnosis.reason) notes.push(diagnosis.reason);
    if (diagnosis.code === 'merge-conflict') conflicts.push(ref);
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
  if (conflicts.length === 0) return end('failed');
  const history = JSON.parse((await ctx.reread(ARTIFACTS.pipelineRebases)) ?? '[]') as string[];
  const sources = conflicts.map((ref) => `${ref.project}@${ref.sha ?? 'unknown'}`);
  if (history.some((source) => sources.includes(source)))
    return end('blocked', 'automatic rebase was already attempted for this SHA');
  if (run.attemptsPipeline >= input.limit) return end('blocked', 'automatic rebase limit reached');
  const changed = await changedWorktree(input.root, run.key, ctx, records);
  if (changed) return end('blocked', changed);
  run.attemptsPipeline += 1;
  await events.recordLoop(run, 'pipeline', run.attemptsPipeline, 'merge conflict: automatic rebase');
  return {
    route: { to: 'wait', reason: 'automatic rebase' },
    summary: `${ctx.opened.startedAt} automatic rebase\n${notes.join('\n')}`,
    outputs: [
      { artifact: ARTIFACTS.pipelineRebases, value: JSON.stringify([...history, ...sources]) },
      { artifact: ARTIFACTS.pipelineLog, value: `result: rebase\n${notes.join('\n')}\n` },
    ],
    visit: { status: 'waiting' },
    afterClose: async (ended) => {
      if (input.halted()) return { ...ended, message: 'automatic rebase cancelled by Stop' };
      try {
        const next = await rebase.rebase(run.key);
        return { ...ended, resume: next === 'resume' };
      } catch (error) {
        const detail = `automatic rebase failed: ${error instanceof Error ? error.message : 'unknown error'}`;
        const fresh = (await runs.findRun(run.key))!;
        fresh.status = 'blocked';
        fresh.ownerPid = null;
        fresh.stepStartedAt = null;
        await ctx.write(ARTIFACTS.error, `${detail}\n`);
        await runs.saveRun(fresh);
        return { exitCode: 1, message: detail };
      }
    },
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
    const project = await originProject(cwd);
    const ref = refs.find((ref) => ref.project === project);
    const [head, branch, dirty] = await Promise.all([
      git(['-C', cwd, 'rev-parse', 'HEAD']),
      git(['-C', cwd, 'branch', '--show-current']),
      git(['-C', cwd, 'status', '--porcelain']),
    ]);
    if (!ref?.sha || ref.sha !== head || ref.ref !== branch || dirty) {
      return `${repo}: published SHA, local branch or working files changed; automatic rebase was blocked`;
    }
  }
  return null;
}
