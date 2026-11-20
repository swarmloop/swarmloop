import Joi from 'joi';
import { readResult } from '../read-result';
import { block } from '../result.spec-helpers';
import { starterAnswer } from './starter-answer';
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
});
