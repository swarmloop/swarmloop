import { skillSection } from '../shared/skill-prompt';
import type { Subtask } from '../../contract/subtask';
import { planAnswersStep, planChatFollowUp, subtaskAsks } from './plan.prompts';

const answer = skillSection('plan', 'Answer a person');
const section = skillSection('plan', 'Decide what you hold');
const escalation = skillSection('plan', 'Escalate what you do not hold');

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

describe('the plan skill, Decide what you hold', () => {
  it('decides from the decisions the run holds, with a one-line reason, and escalates only what none of them settles', () => {
    expect(section).toContain('the decisions this run already holds settle it');
    expect(section).toContain('a one-line reason');
    expect(section).not.toContain('escalate');
  });

  it.each([
    'a new behavior for the product',
    'a change of the requirements or of an order the person set',
    'money (limits, plans)',
    'what a public repository shows about a person',
    'anything that weakens a project rule (security, a test, CI)',
    'anything you are not sure of',
  ])('escalates only in the case: %s', (kind) => {
    expect(escalation).toContain(kind);
  });

  it('names no project and no person', () => {
    expect(`${section}${escalation}`).not.toMatch(/swarmloop|@\w/i);
  });
});

describe('the planner prompts that carry the rule', () => {
  const task = { id: 'a', title: 'A', description: 'Do a', status: 'waiting', depends: [] } as unknown as Subtask;

  it('keeps the answer step of a question on the decisions it already holds, and adds the rule', () => {
    const prompt = planAnswersStep('research', 'Which one?', 'RESULT');
    expect(prompt).toContain('the decisions you already hold');
    expect(prompt).toContain('When it is a product decision you cannot settle from them');
    expect(prompt).toContain(section);
    expect(prompt).toContain(escalation);
  });

  it('gives the message of a person both sections', () => {
    const prompt = planChatFollowUp([{ text: 'hi' }], 'RESULT');
    expect(prompt).toContain(answer);
    expect(prompt).toContain(section);
    expect(prompt).toContain(escalation);
  });

  it('gives a subtask question the decide rule and the escalate section, with and without the task list', () => {
    for (const prompt of [subtaskAsks(task, 'Which?', '- c', null), subtaskAsks(task, 'Which?', '- c', null, [task])]) {
      expect(prompt).toContain(section);
      expect(prompt).toContain(escalation);
    }
  });
});
