import type Joi from 'joi';
import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { planReplyFor } from './plan-reply';

const TASK = {
  id: 'a',
  title: 'Add it',
  depends: [],
  files: ['a.ts'],
  proof: 'a.spec.ts',
  description: 'Adds it.',
};

const fields = (shape: Parameters<typeof planReplyFor>[0]): string[] =>
  Object.keys((planReplyFor(shape).schema as Joi.Schema).describe().keys as object);

const planReply = planReplyFor({ split: true, subtask: false });

describe('plan reply result', () => {
  it('reads a reply alone, and a reply with a plan, requirements and an escalation', () => {
    expect(readResult(planReply, block({ reply: 'Done.' })).ok).toBe(true);
    const full = readResult(
      planReply,
      block({ reply: 'Added.', escalate: 'Which one?', requirements: ['new'], summary: ['why'], plan: ['item'] }),
    );
    expect(full.ok && full.value).toMatchObject({ reply: 'Added.', escalate: 'Which one?', requirements: ['new'] });
  });

  it('needs a reply, and refuses a plan with tasks', () => {
    const none = readResult(planReply, block({ plan: ['item'] }));
    expect(none.ok === false && none.errors).toEqual([expect.stringContaining('reply: ')]);
    const both = readResult(planReply, block({ reply: 'x', plan: ['item'], tasks: [TASK] }));
    expect(both.ok === false && both.errors).toEqual(['result: plan and tasks cannot both be filled in']);
  });

  it('asks a reply for contract items, and refuses a string entry', () => {
    const asked = planReplyFor({ split: true, subtask: false, addTasksOnly: true });
    expect(readResult(asked, block({ reply: 'x', contract: ['old'], tasks: [TASK] })).ok).toBe(false);
    const item = { id: 'api', text: 'rule', owner: 'a' };
    expect(readResult(asked, block({ reply: 'x', contract: [item], tasks: [TASK] })).ok).toBe(true);
  });

  it('says in the prompt that reply is a short answer in plain words with markdown where it helps', () => {
    const text = resultPrompt(planReplyFor({ split: false, subtask: false }));
    expect(text).toContain(
      '- reply (string, required): A short answer in plain words for a person, markdown where it helps',
    );
    expect(text).toContain('- escalate (string, optional)');
    expect(text).toContain('- requirements (array of string, optional)');
    expect(text).toContain('- plan (array of string, optional)');
  });

  it('hides the split keys when the run may not split, and shows them when it may', () => {
    expect(fields({ split: false, subtask: false })).not.toEqual(expect.arrayContaining(['tasks']));
    expect(fields({ split: false, subtask: false })).not.toEqual(expect.arrayContaining(['contract', 'keep']));
    expect(fields({ split: true, subtask: false })).toEqual(expect.arrayContaining(['tasks', 'contract', 'keep']));
    expect(fields({ split: true, subtask: false })).not.toContain('needs');
    expect(fields({ split: true, subtask: true })).toContain('needs');
  });

  it('says the tasks are only the added ones for addTasksOnly', () => {
    expect(resultPrompt(planReplyFor({ split: true, subtask: false, addTasksOnly: true }))).toContain(
      'Only the tasks to add',
    );
  });

  it('shows only reply and escalate for answerOnly', () => {
    expect(fields({ split: true, subtask: false, answerOnly: true })).toEqual(['reply', 'escalate']);
  });

  it('adds a required finding and an optional instruction to an answer about a reviewer finding', () => {
    const shape = { split: false, subtask: false, answerOnly: true, finding: true };
    expect(fields(shape)).toEqual(['reply', 'escalate', 'finding', 'instruction']);
    const answer = planReplyFor(shape);
    expect(readResult(answer, block({ reply: 'It stands.', finding: 'holds' })).ok).toBe(true);
    const full = readResult(answer, block({ reply: 'No.', finding: 'ruled-out', instruction: 'Keep the plan.' }));
    expect(full.ok && full.value).toMatchObject({ finding: 'ruled-out', instruction: 'Keep the plan.' });
    expect(readResult(answer, block({ reply: 'It stands.' })).ok).toBe(false);
    expect(readResult(answer, block({ reply: 'It stands.', finding: 'maybe' })).ok).toBe(false);
  });

  describe('acts', () => {
    const shape = { split: false, subtask: false, answerOnly: true, acts: true };
    const acting = planReplyFor(shape);

    it('shows resume and replay after the answer-only fields, and in no other shape', () => {
      expect(fields(shape)).toEqual(['reply', 'escalate', 'resume', 'replay']);
      expect(fields({ split: false, subtask: false, answerOnly: true })).toEqual(['reply', 'escalate']);
      expect(fields({ split: true, subtask: false })).not.toEqual(expect.arrayContaining(['resume', 'replay']));
    });

    it('reads a resume, and a replay with its step and instruction', () => {
      const resume = readResult(acting, block({ reply: 'On it.', resume: true }));
      expect(resume.ok && resume.value).toMatchObject({ resume: true });
      const replay = readResult(
        acting,
        block({ reply: 'Again.', replay: { step: 'implement', instruction: 'Fix it.' } }),
      );
      expect(replay.ok && replay.value).toMatchObject({ replay: { step: 'implement', instruction: 'Fix it.' } });
    });

    it('refuses resume and replay together', () => {
      const both = readResult(
        acting,
        block({ reply: 'x', resume: true, replay: { step: 'plan', instruction: 'Plan again.' } }),
      );
      expect(both.ok === false && both.errors).toEqual(['result: resume and replay cannot both be given']);
    });

    it('refuses a replay with no step, no instruction, a blank one, done or an unknown step', () => {
      const replay = (value: unknown) => readResult(acting, block({ reply: 'x', replay: value })).ok;
      expect(replay({ instruction: 'Fix it.' })).toBe(false);
      expect(replay({ step: 'implement' })).toBe(false);
      expect(replay({ step: 'implement', instruction: '  ' })).toBe(false);
      expect(replay({ step: 'done', instruction: 'Fix it.' })).toBe(false);
      expect(replay({ step: 'nowhere', instruction: 'Fix it.' })).toBe(false);
    });
  });
});
