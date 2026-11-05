import type { PipelineResult } from '../../core/pipeline-result';
import type { StepContext } from '../base-step';
import { textDocument } from '../shared/handoff';

export function endCommit(
  ctx: StepContext,
  outcome: 'ok' | 'waiting',
  exitCode: number,
  line: string,
  body?: string,
): Promise<PipelineResult> {
  const primary = body ? textDocument('commit', body) : null;
  if (outcome === 'waiting') {
    return ctx.end({ outcome, exitCode, line, visit: { document: primary } });
  }
  return ctx.end({
    outcome,
    exitCode,
    line,
    handoff: body?.trim() ? body : '- committed the branch\n',
    visit: { documents: primary ? [primary] : undefined },
  });
}
