import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { plan, planFor } from './plan';
import { planImprove, planImproveFor } from './plan-improve';
import { subtaskAnswer } from './subtask-answer';

const TASK = {
  id: 'a',
  title: 'Add it',
  depends: [],
  files: ['a.ts'],
  proof: 'a.spec.ts',
  description: 'Adds it.',
};
const PLAN = { summary: ['why'], plan: ['add the field - files: a.ts - proof: a.spec.ts'] };

describe('plan result', () => {
  it('reads a valid plan block and fills in the fields that were left out', () => {
    expect(readResult(plan, block(PLAN))).toEqual({
      ok: true,
      value: { ...PLAN, questions: [], contract: [], tasks: [], keep: [] },
    });
  });

  it('reads questions in place of a plan, and a split in place of both', () => {
    expect(readResult(plan, block({ summary: [], questions: ['which?'] })).ok).toBe(true);
    expect(readResult(plan, block({ summary: [], contract: ['rule'], tasks: [TASK] })).ok).toBe(true);
  });

  it('reads a plan and no questions when questions is an empty list', () => {
    expect(readResult(plan, block({ ...PLAN, questions: [] })).ok).toBe(true);
  });

  it('names a plan that also asks, and an answer that holds nothing', () => {
    const rule = 'exactly one of plan, questions and tasks must be filled in';
    const both = readResult(plan, block({ ...PLAN, questions: ['which?'] }));
    expect(both.ok === false && both.errors).toEqual([`result: ${rule}`]);
    const none = readResult(plan, block({ summary: [] }));
    expect(none.ok === false && none.errors).toEqual([`result: ${rule}`]);
    const split = readResult(plan, block({ ...PLAN, tasks: [TASK] }));
    expect(split.ok === false && split.errors).toEqual([`result: ${rule}`]);
  });

  it('lets a subtask send needs in place of all three', () => {
    expect(readResult(plan, block({ summary: [], needs: [{ id: 't0', what: 'the policy' }] })).ok).toBe(true);
  });

  it('names every schema error at once', () => {
    const read = readResult(plan, block({ plan: 'text', tasks: [{ id: 'a', files: 'a.ts' }], extra: 1 }));
    expect(read.ok === false && read.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('summary: '),
        expect.stringContaining('plan: '),
        expect.stringContaining('tasks.0.title: '),
        expect.stringContaining('tasks.0.files: '),
        expect.stringContaining('tasks.0.proof: '),
        expect.stringContaining('tasks.0.description: '),
        expect.stringContaining('extra: '),
      ]),
    );
  });

  it('keeps colons, nested lists, numbered lines, blank lines and code whole in a description and a list item', () => {
    const description = [
      'Does it:',
      '- nested: yes',
      '  - deeper',
      '1. first',
      '2. second',
      '',
      '```ts',
      'const a = { b: 1 };',
      '```',
    ].join('\n');
    const item = 'add X - files: a.ts - proof: a.spec.ts "does: it"\n  - nested\n\n1. numbered';
    const split = readResult(plan, block({ summary: ['x: y'], contract: [item], tasks: [{ ...TASK, description }] }));
    expect(split.ok && (split.value as { tasks: { description: string }[] }).tasks[0].description).toBe(description);
    expect(split.ok && (split.value as { contract: string[] }).contract).toEqual([item]);
    const listed = readResult(plan, block({ summary: ['x'], plan: [item] }));
    expect(listed.ok && (listed.value as { plan: string[] }).plan).toEqual([item]);
  });

  it('lists every field with its type and description, only the ones a run is asked for', () => {
    const text = resultPrompt(plan);
    expect(text).toContain('- summary (array of string, required): Why this checklist, one line per entry');
    expect(text).toContain('- tasks[].description (string, required): What the task does, kept whole');
    expect(text).toContain('- needs[].id (string, required)');
    const plain = resultPrompt(planFor({ split: false, subtask: false }));
    expect(plain).toContain('- plan (array of string, optional)');
    expect(plain).not.toContain('tasks');
    expect(plain).not.toContain('needs');
    expect(resultPrompt(planFor({ split: true, subtask: false }))).toContain(
      '- tasks[].files (array of string, required)',
    );
    expect(resultPrompt(planFor({ split: false, subtask: true }))).toContain('- needs[].what (string, required)');
  });

  it('keeps the name and kind of the plan result for a run asked for fewer fields', () => {
    const asked = planFor({ split: false, subtask: false });
    expect([asked.name, asked.kind]).toEqual([plan.name, plan.kind]);
  });
});

describe('plan-improve result', () => {
  it('reads a plan, a split and an empty plan', () => {
    expect(readResult(planImprove, block(PLAN)).ok).toBe(true);
    expect(readResult(planImprove, block({ summary: [], contract: ['rule'], tasks: [TASK] })).ok).toBe(true);
    expect(readResult(planImprove, block({ summary: ['kept'] })).ok).toBe(true);
  });

  it('names a plan and tasks sent together', () => {
    const read = readResult(planImprove, block({ ...PLAN, tasks: [TASK] }));
    expect(read.ok === false && read.errors).toEqual(['result: plan and tasks cannot both be filled in']);
  });

  it('asks a run that may not split for the plan only', () => {
    expect(resultPrompt(planImproveFor(false))).not.toContain('tasks');
    expect(resultPrompt(planImproveFor(true))).toContain('- tasks[].proof (string, required)');
  });
});

describe('subtask answer result', () => {
  it('reads the answer whole, and names a missing one', () => {
    const answer = 'Use the helper:\n- one\n\n1. two';
    expect(readResult(subtaskAnswer, block({ answer }))).toEqual({ ok: true, value: { answer } });
    const read = readResult(subtaskAnswer, block({}));
    expect(read.ok === false && read.errors).toEqual(['answer: "answer" is required']);
  });
});
