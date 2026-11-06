import type { StepResult } from '../contract/step-contract';
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
