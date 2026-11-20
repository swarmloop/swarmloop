import { readResult } from '../read-result';
import { block } from '../result.spec-helpers';
import { implementation } from './implementation';
import { implementationImprove } from './implementation-improve';
import { completePlan, plan, planFor } from './plan';

const CHANGE = { type: 'fix', scope: 'api', subject: 'Reject an empty title' };
const PLAN = { summary: ['why'], plan: ['add it - files: a.ts - proof: a.spec.ts'] };
const TASK = {
  id: 'a',
  title: 'Add it',
  depends: [],
  files: ['a.ts'],
  proof: 'a.spec.ts',
  description: 'Adds it.',
};
const IMPLEMENTED = { implementation: ['a'], summary: ['b'] };

describe('change of a plan', () => {
  it('reads a plan with a change, with a scope left out, and without one', () => {
    expect(readResult(plan, block({ ...PLAN, change: CHANGE })).ok).toBe(true);
    expect(readResult(plan, block({ ...PLAN, change: { type: 'feat', subject: 'Add it' } })).ok).toBe(true);
    expect(readResult(plan, block(PLAN)).ok).toBe(true);
  });

  it('completes a stored plan that has no change', () => {
    expect(completePlan(PLAN).change).toBeUndefined();
  });

  it('refuses a type outside the list and a subject over 72 characters', () => {
    expect(readResult(plan, block({ ...PLAN, change: { ...CHANGE, type: 'update' } })).ok).toBe(false);
    expect(readResult(plan, block({ ...PLAN, change: { ...CHANGE, subject: 'a'.repeat(72) } })).ok).toBe(true);
    expect(readResult(plan, block({ ...PLAN, change: { ...CHANGE, subject: 'a'.repeat(73) } })).ok).toBe(false);
    expect(readResult(plan, block({ ...PLAN, change: { type: 'fix' } })).ok).toBe(false);
  });

  it('reads a split task with and without a change of its own', () => {
    const split = (task: object) =>
      block({ summary: [], contract: [{ id: 'rule', text: 'rule', owner: 'a' }], tasks: [task] });
    expect(readResult(planFor({ split: true, subtask: false }), split({ ...TASK, change: CHANGE })).ok).toBe(true);
    expect(readResult(planFor({ split: true, subtask: false }), split(TASK)).ok).toBe(true);
    expect(readResult(planFor({ split: true, subtask: false }), split({ ...TASK, change: { type: 'x' } })).ok).toBe(
      false,
    );
  });
});

describe('change and gitRules of an implementation', () => {
  const rules = { branch: '{type}/{slug}', commit: '{type}: {subject}', title: '[{ticket} ]{subject}' };

  it.each([
    ['implementation', implementation, IMPLEMENTED],
    ['implementation improve', implementationImprove, { summary: ['b'] }],
  ])('reads %s with both fields, with one, and with neither', (_name, definition, given) => {
    expect(readResult(definition, block({ ...given, change: CHANGE, gitRules: rules })).ok).toBe(true);
    expect(readResult(definition, block({ ...given, gitRules: { title: 'x' } })).ok).toBe(true);
    expect(readResult(definition, block(given)).ok).toBe(true);
  });

  it.each([
    ['implementation', implementation, IMPLEMENTED],
    ['implementation improve', implementationImprove, { summary: ['b'] }],
  ])('refuses an invalid change or rule in %s', (_name, definition, given) => {
    expect(readResult(definition, block({ ...given, change: { ...CHANGE, subject: 'a'.repeat(73) } })).ok).toBe(false);
    expect(readResult(definition, block({ ...given, gitRules: { branch: 5 } })).ok).toBe(false);
  });
});
