import { returnNotes } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue, Issue, Route, StepResult } from '../contract/step-contract';

export function finish(
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
  line: string,
  visitStatus: string,
  body?: string,
  issues?: Issue[],
): StepResult {
  const outputs: ArtifactValue[] = [];
  if (body) {
    outputs.push({ artifact: ARTIFACTS.pipelineLog, value: body });
  }
  if (issues && body) {
    outputs.push(
      { artifact: ARTIFACTS.return, value: returnNotes([{ source: 'pipeline', body }]).body },
      { artifact: ARTIFACTS.issues, value: issues },
    );
  }
  let handoff: string | undefined;
  if (outcome === 'ok' || issues) {
    const head = issues
      ? 'Pipeline failed and returned to implement.'
      : body?.includes('CI skipped')
        ? body.trim()
        : body?.includes('result: none')
          ? 'Nothing started.'
          : 'Pipeline passed.';
    handoff = `- ${head}\n`;
  }
  return { route: routeOf(outcome, line, issues), summary: line, outputs, handoff, visit: { status: visitStatus } };
}

function routeOf(outcome: 'ok' | 'failed' | 'blocked' | 'waiting', line: string, issues?: Issue[]): Route {
  switch (outcome) {
    case 'ok':
      return { to: 'next' };
    case 'failed':
      return { to: 'fail', error: { code: 'pipeline', message: line } };
    case 'blocked':
      return { to: 'block', reason: line };
    case 'waiting':
      return issues ? { to: 'return', step: 'implement', issues } : { to: 'wait', reason: line };
  }
}
