import { ERROR_CODES } from '../../contract/error-codes';
import type { StepName } from '../../contract/steps';
import type { StepEventLog } from '../../history/step-event.log';
import type { SandboxMount } from '../../core/sandbox-mount';
import { implementation, type ImplementationResult } from '../../agent-result/definitions/implementation';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { withEnvironment } from '../../environment/environment-note';
import { staleRepos } from '../pipeline/pipeline-report';
import { pipelineRefRepos } from '../pipeline/pipeline-ref-repos';
import { ARTIFACTS } from '../contract/artifacts';
import type { Issue, StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { textDocument } from '../shared/handoff';
import { correctedPlan, renderSummary } from '../plan/plan-record';

/** The visit summary of a CI rerun after an unchanged pipeline failure; the agent's own explanation follows it. */
const UNFIXED_RERUN = 'pipeline failure left unchanged, CI rerun: ';
const NO_EXPLANATION = 'the agent gave no explanation';

/** What a pipeline return whose first answer left the files unchanged needs from the implement visit. */
interface UnchangedReturn {
  ctx: ModelStepContext;
  events: StepEventLog;
  step: StepName;
  requirements: string;
  /** The checklist before this visit, and the corrected one the answers sent so far. */
  items: string[];
  plan: string[] | undefined;
  notes: string | null;
  issues: Issue[];
  unfixed: Set<string>;
  mounts: SandboxMount[];
  /** What the retry launch shares with the first one: mounts, hosts and the project. */
  workplace: Omit<Parameters<ModelStepContext['launch']>[0], 'prompt'>;
  executionRules: string;
  unchanged: () => Promise<boolean>;
  assertUncommitted: () => Promise<void>;
}

/** The step stopped here, or goes on with the answer of the retry and the checklist the answers corrected so far. */
type UnchangedOutcome = { stop: StepResult } | { value: ImplementationResult; plan: string[] | undefined };

/**
 * A pipeline return the first answer left unchanged on disk: a failure that repeats on the same commit blocks, any
 * other gets one more turn, and when that leaves the files unchanged too, CI runs again on the same commit.
 */
export async function retryUnchangedPipeline(
  input: UnchangedReturn,
  first: ImplementationResult,
): Promise<UnchangedOutcome> {
  const { ctx } = input;
  const repeated = input.issues.find((issue) => input.unfixed.has(issue.id));
  if (repeated) {
    const explanation = await previousExplanation(input.events, ctx.opened.run.id, input.step);
    const line = `${ctx.opened.startedAt} ${repeated.title} failed twice on the same commit and the agent changed nothing: ${explanation}`;
    return {
      stop: { route: { to: 'block', code: ERROR_CODES.PIPELINE_UNFIXED, reason: line }, summary: line, outputs: [] },
    };
  }
  const answered = await ctx.launch({
    ...input.workplace,
    prompt: withEnvironment(
      `The pipeline failure still stands and the files are unchanged.\n\n${input.notes?.trim() ?? ''}\n\n${resultPromptFor(implementation, implementation.name)}`,
      input.executionRules,
    ),
    result: implementation,
  });
  await input.assertUncommitted();
  const value = answered.resultValue as ImplementationResult;
  const plan = value.plan?.length ? value.plan : input.plan;
  if (!(await input.unchanged())) {
    return {
      value: {
        ...value,
        implementation: value.implementation.length > 0 ? value.implementation : first.implementation,
      },
      plan,
    };
  }
  const pipelineRef = await ctx.reread(ARTIFACTS.pipelineRef);
  const stale = await staleRepos(pipelineRef, input.mounts);
  if (stale.length > 0) {
    return {
      stop: {
        route: { to: 'jump', step: 'commit' },
        summary: `${ctx.opened.startedAt} no change needed: the failed pipeline ran on an older commit`,
        outputs: [],
        visit: { documents: [textDocument(ARTIFACTS.ciRerun.kind, `${stale.join('\n')}\n`)] },
      },
    };
  }
  const explanation = renderSummary(value.summary, []).trim() || NO_EXPLANATION;
  return { stop: rerunResult(input, plan, explanation, await pipelineRefRepos(pipelineRef, input.mounts)) };
}

/** The explanation the agent gave on the CI rerun the last implement visit asked for. */
async function previousExplanation(events: StepEventLog, runId: number, step: StepName): Promise<string> {
  let last = '';
  let after = 0;
  for (;;) {
    const page = await events.page(runId, { step, after });
    for (const event of page.events) {
      if (event.kind === 'attempt.finished' && event.summary.startsWith(UNFIXED_RERUN)) {
        last = event.summary.slice(UNFIXED_RERUN.length).trim();
      }
    }
    if (page.next === null) {
      return last || NO_EXPLANATION;
    }
    after = page.next;
  }
}

/** A pipeline failure the retry left unchanged on disk: CI runs the failed jobs again on the same commit. */
function rerunResult(
  input: UnchangedReturn,
  plan: string[] | undefined,
  explanation: string,
  repos: string[],
): StepResult {
  const corrected = correctedPlan(input.requirements, plan, input.items);
  const documents = [
    ...(input.issues.length > 0
      ? [textDocument(ARTIFACTS.unfixedIssue.kind, input.issues.map((issue) => issue.id).join('\n'))]
      : []),
    textDocument(ARTIFACTS.ciRerun.kind, `${repos.join('\n')}\n`),
    ...(corrected ? [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] : []),
  ];
  return {
    route: { to: 'jump', step: 'commit' },
    summary: `${input.ctx.opened.startedAt} ${UNFIXED_RERUN}${explanation}`,
    outputs: [],
    handoff: corrected?.handoff,
    visit: { documents },
  };
}
