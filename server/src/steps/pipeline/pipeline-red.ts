import { type AppConfig, type SwarmloopEnv } from '../../config/env';
import type { EventRepository } from '../../history/event.repository';
import type { VisitRepository } from '../../history/visit.repository';
import { root } from '../../history/run-paths';
import type { EnvironmentService } from '../../environment/environment.service';
import type { OpenedStep } from '../../steps/step-run';
import type { CodeHost } from '../../integrations/code-host/code-host';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { readFailures } from './ci-host';
import { pipelineReturn } from './ci-only';
import { finish } from './pipeline-result';
import { noteSkippedByPaths } from './pipeline-skipped';
import { failureIssues, renderFail, renderUnreadable, type Seen } from './pipeline-report';

export interface RedDeps {
  environments: EnvironmentService;
  events: EventRepository;
  visits: VisitRepository;
  config: AppConfig;
}

export async function red(
  deps: RedDeps,
  ctx: StepContext,
  env: SwarmloopEnv,
  seen: Seen[],
  host: CodeHost,
  note = '',
  traces = true,
): Promise<StepResult> {
  const { opened, calls } = ctx;
  // A run swarmloop canceled itself (it comes with a note) has canceled jobs that are its failure; otherwise only failed jobs are.
  const counted = note ? ['failed', 'canceled', 'timed_out'] : ['failed'];
  const failures = traces ? await readFailures(seen, calls, host, counted) : [];
  const unreadable = renderUnreadable(failures);
  if (unreadable) {
    return finish('blocked', report(opened, 'pipeline log unavailable', unreadable), 'blocked', unreadable);
  }
  await noteSkippedByPaths(deps.environments, opened.run.key, failures);
  const body = traces ? renderFail(failures, seen, note) : `${note.trim()}\n`;
  if (ctx.options.auto && (await sameFailure(ctx, seen))) {
    return finish('failed', report(opened, 'pipeline already failed for this commit', body), 'failed', body);
  }
  if (opened.run.attemptsPipeline >= env.MAX_PIPELINE_RETURNS) {
    const text = report(opened, 'pipeline return limit reached', body);
    return finish('blocked', text, 'blocked', body);
  }
  opened.run.attemptsPipeline += 1;
  const { reason, detail } = await pipelineReturn(failures, seen, ctx, deps.visits, root(deps.config));
  await deps.events.recordLoop(opened.run, 'pipeline', opened.run.attemptsPipeline, reason, detail);
  const issues = failureIssues(failures, body);
  return finish('waiting', report(opened, 'pipeline failed', body), 'waiting', body, issues);
}

async function sameFailure(ctx: StepContext, seen: Seen[]): Promise<boolean> {
  const previous = (await ctx.reread(ARTIFACTS.pipelineLog)) ?? '';
  const lines = new Set(previous.split('\n').map((line) => line.trim()));
  if (!lines.has('result: fail')) {
    return false;
  }
  const failed = seen.filter((item) => item.status === 'failed' || item.status === 'canceled');
  return failed.length > 0 && failed.every((item) => item.id !== null && lines.has(`pipeline: ${item.id}`));
}

export function report(opened: OpenedStep, text: string, body = ''): string {
  const head = `${opened.startedAt} ${text}`;
  return body ? `${head}\n${body.trimEnd()}` : head;
}
