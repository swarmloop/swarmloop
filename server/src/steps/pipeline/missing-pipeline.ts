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
import { CI_LOOK_MS, waitForCi } from './ci-not-started';
import { ERROR_CODES } from '../../contract/error-codes';

/** Only the trigger is automatic. Rebase itself is the action used by the API button. */
export async function missingPipeline(input: {
  ctx: StepContext;
  runs: RunRepository;
  events: EventRepository;
  rebase: Pick<RunRebase, 'rebase' | 'subtasksIdle' | 'baseTips' | 'handHostConflict'>;
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
  const reasons: string[] = [];
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
      if (diagnosis.reason) reasons.push(diagnosis.reason);
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
  const history = JSON.parse((await ctx.reread(ARTIFACTS.pipelineRebases)) ?? '[]') as string[];
  if (run.attemptsPipeline >= input.limit) {
    return end('blocked', `automatic rebase limit reached; tried: ${triedText(history)}`);
  }
  const changed = await changedWorktree(input.root, run.key, ctx, records);
  if (changed) return end('blocked', changed);
  const retryAt = new Date(ctx.clock.now() + CI_LOOK_MS).toISOString();
  const wait = (text: string, outputs: StepResult['outputs'], afterClose?: StepResult['afterClose']): StepResult => ({
    route: { to: 'wait', reason: text, code: ERROR_CODES.CI_NOT_STARTED, retryAt },
    summary: `${ctx.opened.startedAt} ${text}\n${notes.join('\n')}`,
    outputs,
    visit: { status: 'waiting' },
    afterClose,
  });
  const log = [{ artifact: ARTIFACTS.pipelineLog, value: `result: rebase\n${notes.join('\n')}\n` }];
  if (!(await rebase.subtasksIdle(run))) {
    return wait(`the epic's parts are still running; next try at ${retryAt}`, log);
  }
  const tips = await rebase.baseTips(run.key);
  const keys = conflicts.map((ref) => `${ref.project}@${ref.sha ?? 'unknown'}@${tips}`);
  const hostConflict = reasons.join('\n');
  if (keys.every((key) => history.includes(key))) {
    const text = `merge conflict sent to the implement agent; next look at ${retryAt}`;
    return wait(text, log, async (ended) => {
      await rebase.handHostConflict(run.key, hostConflict);
      return ended;
    });
  }
  run.attemptsPipeline += 1;
  await events.recordLoop(run, 'pipeline', run.attemptsPipeline, 'merge conflict: automatic rebase');
  return wait(
    `automatic rebase; next look at ${retryAt}`,
    log,
    automaticRebase({ ctx, runs, rebase, halted: input.halted, hostConflict, record: { history, keys } }),
  );
}

/** Each recorded try as `<project> at <head> onto <tips>`; an old entry has no tips. */
function triedText(history: string[]): string {
  if (history.length === 0) return 'none';
  return history
    .map((entry) => {
      const [project, head, ...tips] = entry.split('@');
      return tips.length > 0 ? `${project} at ${head} onto ${tips.join('@')}` : `${project} at ${head}`;
    })
    .join('; ');
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

/** Repo names that have a workflow file and no run. Null when the repo list is missing. */
export async function missingRuns(ctx: StepContext, root: string, seen: Seen[]): Promise<string[] | null> {
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
  const missing: string[] = [];
  for (const name of names) {
    const dir = worktreePath(root, ctx.opened.run.key, name);
    if (!hasCi(dir)) {
      continue;
    }
    const project = await withWorktree(dir, () => originProject(dir));
    const run = project ? seen.find((item) => item.project === project) : undefined;
    if (!run || run.runs.length === 0) {
      missing.push(name);
    }
  }
  return missing;
}
