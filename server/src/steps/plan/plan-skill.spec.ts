import { readFileSync } from 'fs';
import { join } from 'path';
import { plannerCore } from '../shared/planner-core';
import { skillPrompt, skillSection } from '../shared/skill-prompt';
import type { Subtask } from '../../contract/subtask';
import { planAnswersStep, planChatFollowUp, planChatTakes, subtaskAsks } from './plan.prompts';

const raw = readFileSync(join(__dirname, '../../../../skills/plan/SKILL.md'), 'utf8');
const core = plannerCore();
const answer = skillSection('plan', 'Answer a person');
const section = skillSection('plan', 'Decide what you hold');
const passUp = skillSection('plan', 'Pass up what you do not hold');
const escalation = skillSection('plan', 'Escalate what you do not hold');

const CASES = [
  "a new behavior for the product's users",
  'a change of the requirements or the goal, or of an order the person set',
  'money (limits, plans)',
  'what a public repository shows about a person',
  'anything that weakens a project rule (security, a test, CI)',
  'anything you are not sure of',
];

describe('the plan skill, Answer a person', () => {
  it('points to the rule of the decisions the run holds and never invents a product decision', () => {
    expect(answer).toContain('Decide as `Decide what you hold` says');
    expect(answer).toContain('escalate as `Escalate what you do not hold` says');
    expect(answer).toContain('never invent a product decision');
  });

  it('names only what its actions do and asks up the chain for the rest', () => {
    const sentence =
      'Your reply names only what your actions do. What you have no action for, such as bringing main into a tree or acting on a run that is not your own, you ask up the chain, and you never write it as done.';
    expect(answer).toContain(sentence);
    expect(planChatFollowUp([{ text: 'hi' }], 'RESULT')).toContain(sentence);
  });
});

describe('the plan skill and the planner core', () => {
  it('includes the core once, after Answer a person, and repeats none of its rules', () => {
    expect(raw.split('[planner core]')).toHaveLength(2);
    expect(raw.indexOf('[planner core]')).toBeGreaterThan(raw.indexOf('## Answer a person'));
    expect(raw).not.toContain('Give each decision with a one-line reason');
    for (const kind of CASES) expect(raw).not.toContain(kind);
  });

  it('keeps the core out of a first plan prompt', () => {
    for (const split of [false, true]) {
      const prompt = skillPrompt('plan', '{}', ['api'], [], [], { split });
      expect(prompt).not.toContain('Pass up what you do not hold');
      expect(prompt).not.toContain('Give each decision with a one-line reason');
    }
  });
});

describe('the plan skill, Decide what you hold', () => {
  it('decides from the decisions the run holds, with a one-line reason, and escalates only what none of them settles', () => {
    expect(section).toContain('the decisions you already hold');
    expect(section).toContain('a one-line reason');
    expect(section).not.toContain('escalate');
  });

  it('holds how the steps of a run work, and answers a question a step mode settles without passing it up', () => {
    for (const text of [section, core]) {
      expect(text).toContain('how the steps of a run work');
      expect(text).toContain('never passed up');
    }
  });

  it.each(CASES)('escalates only in the case: %s', (kind) => {
    expect(passUp).not.toBe('');
    expect(passUp).toContain(kind);
    expect(core.split(kind)).toHaveLength(2);
  });

  it('names no project and no person', () => {
    expect(`${core}${section}${passUp}${escalation}`).not.toMatch(/swarmloop|@\w/i);
  });
});

describe('the planner prompts that carry the rule', () => {
  const task = { id: 'a', title: 'A', description: 'Do a', status: 'waiting', depends: [] } as unknown as Subtask;
  const notCarried = ['The look after a merge', 'A fact checked by its quote'];

  function carriesRule(prompt: string): void {
    expect(prompt).toContain(passUp);
    expect(prompt).toContain(escalation);
    for (const heading of notCarried) expect(prompt).not.toContain(heading);
  }

  it('keeps the answer step of a question on the decisions it already holds, and adds the rule', () => {
    const prompt = planAnswersStep('research', 'Which one?', 'RESULT');
    expect(prompt).toContain('the decisions you already hold');
    expect(prompt).toContain('When it is a product decision you cannot settle from them');
    expect(prompt).toContain(section);
    carriesRule(prompt);
  });

  it('gives the message of a person both sections', () => {
    const prompt = planChatFollowUp([{ text: 'hi' }], 'RESULT');
    expect(prompt).toContain(answer);
    expect(prompt).toContain(section);
    carriesRule(prompt);
  });

  it("tells the planner of a run no step drives what it may do, with the person's words", () => {
    const prompt = planChatTakes([{ text: ' first ' }, { text: 'second' }], 'RESULT');
    for (const part of [answer, section, "The person's words:\nfirst\n\nsecond", 'RESULT'])
      expect(prompt).toContain(part);
    carriesRule(prompt);
    expect(prompt).toContain('No step runs now. You may only answer; or resume,');
    expect(prompt).toContain('replay from a step with an instruction, which is the replay prompt');
    expect(prompt).not.toContain('You plan one task of an epic');
    expect(planChatTakes([{ text: 'hi' }], 'RESULT', true)).toContain('You plan one task of an epic');
  });

  it('gives a subtask question the decide rule and the escalate section, with and without the task list', () => {
    for (const prompt of [subtaskAsks(task, 'Which?', '- c', null), subtaskAsks(task, 'Which?', '- c', null, [task])]) {
      expect(prompt).toContain(section);
      carriesRule(prompt);
    }
  });
});
