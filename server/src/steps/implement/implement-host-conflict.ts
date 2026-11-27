import { root } from '../../history/run-paths';
import { mountsForStep } from '../../git/repo-names';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import type { PlanChatEntry } from '../../contract/plan-chat';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { hostConflictPrompt } from './implement.prompts';
import { resolvedResult, type RebaseDeps } from './rebase-resolved';
import { takeAnswer } from './implement-question';

/** The base tips the run recorded as `<repo>@<sha>`, sorted, or 'unknown' when none is recorded. */
function baseText(tips: Record<string, string> | null): string {
  const entries = Object.entries(tips ?? {}).map(([repo, sha]) => `${repo}@${sha}`);
  return entries.length > 0 ? entries.sort().join(', ') : 'unknown';
}

/**
 * The server moved the branch onto its base and git found no conflict, yet the code host reports one. The conflict
 * agent changes the branch's files once; the result then goes to checks or code review like any resolved conflict.
 */
export async function settleHostConflict(
  deps: RebaseDeps,
  requirements: string,
  ctx: ModelStepContext,
  names: string[],
  text: string,
  answer: PlanChatEntry | null = null,
): Promise<StepResult> {
  const { run } = ctx.opened;
  const mounts = mountsForStep(root(deps.config), run.key, names, run.targetPath);
  const place = { run, key: run.key, step: deps.step, mounts, runtime: deps.runtime, samples: ctx.samples };
  const workplace = await agentWorkplace(
    deps.environments,
    place,
    `${hostConflictPrompt({ repos: names, conflict: text, requirements, base: baseText(run.baseTips), answer })}\n`,
  );
  const resolved = await ctx.launch({
    ...workplace,
    projectFor: projectFor(deps.environments, place),
    mounts,
    resume: false,
    result: rebaseResolution,
  });
  await takeAnswer(deps.chat, run.key, answer);
  await ctx.write(ARTIFACTS.rebaseResolutionResult, resolved.resultValue as RebaseResolutionResult);
  return resolvedResult(deps, ctx, mounts, '- resolved the conflict the code host reported\n');
}
