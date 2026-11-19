import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { SandboxMount } from '../../core/sandbox-mount';
import { worktreeStatus } from '../../git/worktree-git';
import type { RebaseStop } from '../../git/rebase';
import type { EnvironmentService } from '../../environment/environment.service';
import { textDocument } from '../shared/handoff';
import type { RebasedPublisher } from '../shared/rebased-publisher';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { firstPass, renderImplementation } from './implement-record';

/** What finishing an open rebase needs from the implement step. */
export interface RebaseDeps {
  config: AppConfig;
  documents: DocumentRepository;
  flows: FlowRepository;
  publisher: RebasedPublisher;
  environments: EnvironmentService;
  step: string;
  runtime: RuntimeName;
}

/** What follows a resolved conflict: the rebased code is checked and reviewed, from the stored implementation. */
export async function resolvedResult(
  deps: RebaseDeps,
  ctx: ModelStepContext,
  mounts: SandboxMount[],
  handoff: string,
): Promise<StepResult> {
  const { key } = ctx.opened.run;
  // The rebased code is checked again before it is reviewed, when the run has the checks phase.
  const next = (await deps.flows.activePhases(ctx.opened.run.id)).includes('checks') ? 'checks' : 'code-review';
  await deps.flows.noteFlow(key, next === 'checks' ? ['checks', 'code-review', 'ci'] : ['code-review', 'ci'], next);
  const existing = await firstPass(ctx);
  if (!existing?.implementation.length) {
    throw new SwarmloopError('implementation is missing');
  }
  const body = renderImplementation(existing.implementation);
  const status = await worktreeStatus(mounts);
  return {
    route: { to: 'jump', step: next },
    summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
    outputs: [
      { artifact: ARTIFACTS.implementation, value: body },
      { artifact: ARTIFACTS.implementationResult, value: existing },
    ],
    handoff,
    visit: {
      documents: [
        textDocument(ARTIFACTS.rebaseConflict.kind, 'review\n'),
        textDocument(ARTIFACTS.rebaseMergeSkip.kind, 'skip\n'),
      ],
    },
  };
}

export function failConflict(
  deps: RebaseDeps,
  ctx: ModelStepContext,
  outcome: Extract<RebaseStop, { kind: 'conflict' }>,
): StepResult {
  const detail = [outcome.files.join(', '), outcome.stderr.trim()].filter((part) => part.length > 0).join('\n');
  const line = `${ctx.opened.startedAt} ${outcome.repo} rebase failed: ${detail}`;
  return { route: { to: 'fail', error: { code: deps.step, message: line } }, summary: line, outputs: [] };
}
