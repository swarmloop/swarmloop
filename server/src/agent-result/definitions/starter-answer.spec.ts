import Joi from 'joi';
import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { implementationFor } from './implementation';
import { implementationImproveFor } from './implementation-improve';
import { planFor } from './plan';
import { researchFor } from './research';
import { starterAnswer, starterAnswerWithoutEscalate } from './starter-answer';
import { starterKeys, type OutOfScope, type StarterDecision } from './starter-fields';
import { subtaskAnswer } from './subtask-answer';

const TASK = {
  id: 'docs',
  title: 'Docs',
  depends: [],
  files: ['README.md'],
  proof: 'a check',
  description: 'Writes the docs.',
};

describe('starter answer', () => {
  it('reads a decision alone, and with every action', () => {
    expect(readResult(starterAnswer, block({ decision: 'use UTC' })).ok).toBe(true);
    const full = {
      decision: 'use UTC',
      waitFor: [{ id: 'core', what: 'the helper' }],
      addTask: [TASK],
      changeTask: [{ id: 'later', reason: 'the name moved', files: ['b.ts'] }],
      dropTask: [{ id: 'gone', reason: 'nothing left to do' }],
    };
    expect(readResult(starterAnswer, block(full))).toMatchObject({ ok: true, value: { waitFor: full.waitFor } });
  });

  it('refuses an answer with no decision, a drop with no reason and a task with no proof', () => {
    expect(readResult(starterAnswer, block({ waitFor: [] })).ok).toBe(false);
    expect(readResult(starterAnswer, block({ decision: 'x', dropTask: [{ id: 'gone' }] })).ok).toBe(false);
    const { proof: _proof, ...bare } = TASK;
    expect(readResult(starterAnswer, block({ decision: 'x', addTask: [bare] })).ok).toBe(false);
  });

  it('reads an escalation alone and refuses an answer with neither a decision nor an escalation', () => {
    expect(readResult(starterAnswer, block({ escalate: 'which currency?' }))).toMatchObject({
      ok: true,
      value: { escalate: 'which currency?' },
    });
    expect(readResult(starterAnswer, block({ decision: 'x', escalate: 'y' })).ok).toBe(true);
    expect(readResult(starterAnswer, block({ waitFor: [{ id: 'core', what: 'the helper' }] })).ok).toBe(false);
  });

  it("reads a typed finding of 'holds' or 'ruled-out' and refuses any other value", () => {
    expect(readResult(starterAnswer, block({ decision: 'x', finding: 'holds' }))).toMatchObject({
      ok: true,
      value: { finding: 'holds' },
    });
    expect(readResult(starterAnswer, block({ decision: 'x', finding: 'ruled-out' })).ok).toBe(true);
    expect(readResult(starterAnswer, block({ decision: 'x', finding: 'maybe' })).ok).toBe(false);
  });

  it('has a variant without escalate of the same kind, that refuses an escalation', () => {
    expect(starterAnswerWithoutEscalate.kind).toBe(starterAnswer.kind);
    expect(starterAnswerWithoutEscalate.name).toBe(starterAnswer.name);
    expect(readResult(starterAnswerWithoutEscalate, block({ decision: 'use UTC' })).ok).toBe(true);
    expect(readResult(starterAnswerWithoutEscalate, block({ escalate: 'which currency?' })).ok).toBe(false);
    expect(readResult(starterAnswerWithoutEscalate, block({ decision: 'x', escalate: 'y' })).ok).toBe(false);
    expect(readResult(starterAnswerWithoutEscalate, block({ decision: 'x', finding: 'holds' })).ok).toBe(false);
  });

  it('still reads the words-only subtask_answer body', () => {
    expect(readResult(subtaskAnswer, block({ answer: 'use UTC' }))).toEqual({ ok: true, value: { answer: 'use UTC' } });
  });
});

describe('starter fields', () => {
  const schema = Joi.object(starterKeys());

  it('are all optional and typed', () => {
    expect(schema.validate({}).error).toBeUndefined();
    const decisions: StarterDecision[] = [{ item: 'api', text: 'named x' }];
    const outOfScope: OutOfScope[] = [{ what: 'the relaunch', needed: false }];
    const given = { question: 'which?', decisions, outOfScope };
    expect(schema.validate(given).error).toBeUndefined();
    expect(schema.validate({ decisions: [{ item: 'api' }] }).error).toBeDefined();
    expect(schema.validate({ outOfScope: [{ what: 'x' }] }).error).toBeDefined();
  });

  it.each([
    ['research', researchFor(true)],
    ['plan', planFor({ split: false, subtask: true })],
    ['implementation', implementationFor({ subtask: true, review: false })],
    ['implementation-improve', implementationImproveFor({ subtask: true, review: false })],
  ])('describe outOfScope as work that no step of the task will do, for %s', (_step, definition) => {
    const prompt = resultPrompt(definition);
    expect(prompt).toContain('Parts of the work that no step of this task and no other task will do');
    expect(prompt).toContain("the work of this task's own later steps (plan, implement, review) is never out of scope");
    expect(prompt).toContain('a step that cannot write never lists the writing');
    expect(prompt).toContain('true when this task cannot go on without that part');
  });
});
