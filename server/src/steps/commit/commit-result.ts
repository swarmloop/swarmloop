import type { Issue, StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';

export function commitResult(outcome: 'ok' | 'waiting', line: string, body?: string): StepResult {
  const outputs = body ? [{ artifact: ARTIFACTS.commit, value: body }] : [];
  if (outcome === 'waiting') {
    return { route: { to: 'wait', reason: 'commit waiting' }, summary: line, outputs };
  }
  return {
    route: { to: 'next' },
    summary: line,
    outputs,
    handoff: body?.trim() ? body : '- committed the branch\n',
  };
}

export const DELIVERED_PREFIX = 'already delivered:';

/** The run ends `done` with no merge request: the note is the commit document, which the parent reads. */
export function deliveredResult(startedAt: string, where: string): StepResult {
  const note = `${DELIVERED_PREFIX} ${where}`;
  return {
    route: { to: 'jump', step: 'done' },
    summary: `${startedAt} commit done\n${note}`,
    outputs: [{ artifact: ARTIFACTS.commit, value: `${note}\n` }],
    handoff: `- ${note}\n`,
  };
}

/** An unchanged tree whose task is not delivered goes back to implement with the issue. */
export function undeliveredResult(startedAt: string, issues: Issue[]): StepResult {
  return {
    route: { to: 'return', step: 'implement', issues },
    summary: `${startedAt} commit waiting\n${issues[0].title}`,
    outputs: [{ artifact: ARTIFACTS.issues, value: issues }],
  };
}
