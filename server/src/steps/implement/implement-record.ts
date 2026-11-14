import type { StepResult } from '../contract/step-contract';
import type { AttemptFacts } from '../../contract/step-events';
import type { ImplementationResult } from '../../agent-result/definitions/implementation';
import { legacyImplementation } from '../../agent-result/legacy/implementation';
import { ARTIFACTS } from '../contract/artifacts';
import type { ModelStepContext } from '../agent-step';

/** The `implementation` document: one `- item` line each, the later lines of an item indented by two spaces. */
export function renderImplementation(items: string[]): string {
  const lines = items.map((item) => `- ${item.split('\n').join('\n  ')}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** The `cause` lines of an answer, ahead of its summary in the handoff. */
export function renderCause(cause: string[]): string {
  return `cause:\n${cause.map((line) => `- ${line}`).join('\n')}\n\n`;
}

/**
 * The latest first pass of a run: the stored result, else the `implementation` document of a run that started before
 * results were stored. Null when the run has neither.
 */
export async function firstPass(ctx: ModelStepContext): Promise<ImplementationResult | null> {
  const stored = await ctx.reread(ARTIFACTS.implementationResult);
  if (stored) {
    return stored;
  }
  const body = await ctx.reread(ARTIFACTS.implementation);
  return body?.trim() ? legacyImplementation(body) : null;
}

export function withReturnNotes(
  sections: { heading: string; body: string }[],
  returned: string | null,
): { heading: string; body: string }[] {
  return returned?.trim() ? [...sections, { heading: 'Why this returned', body: returned }] : sections;
}

/** A check that failed again on unchanged files: the run waits for a person, and the stored return notes stay. */
export function checkRepeatedBlock(startedAt: string, step: string, error: Error): StepResult {
  return {
    route: { to: 'block', reason: error.message },
    summary: `${startedAt} ${step} blocked: ${error.message}`,
    outputs: [],
  };
}

/** The checks result as a line: `8 of 8 passed`. */
export function checksLine(result: { passed: number; total: number }): string {
  return result.total === 0 ? 'no checks' : `${result.passed} of ${result.total} passed`;
}

/** What the server checks said, for the event that ends an implement attempt. */
export function implementFacts(checks: string | null): AttemptFacts | undefined {
  return checks ? { details: [`checks: ${checks}`] } : undefined;
}
