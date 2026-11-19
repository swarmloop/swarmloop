import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { backlogTurn } from './backlog-turn';

const errorsOf = (value: unknown): string[] => {
  const read = readResult(backlogTurn, block(value));
  return read.ok ? [] : read.errors;
};

describe('backlog turn result', () => {
  it('reads a message with actions of every kind', () => {
    const read = readResult(
      backlogTurn,
      block({
        say: 'Here is the plan. Run it?',
        actions: [
          { action: 'proposeMilestone', title: 'T', goal: 'G' },
          { action: 'addRequirements', milestone: 1, texts: ['it works'] },
          { action: 'addTasks', tasks: [{ id: 'a', title: 'A', description: 'D', covers: ['M1.R1'] }], reason: 'x' },
          { action: 'changeTask', task: 'a', description: 'new' },
          { action: 'closeRequirement', id: 'M1.R1', evidence: 'merged' },
          { action: 'answerRun', run: 'r', answers: [{ body: 'yes' }] },
          { action: 'planChat', run: 'r', message: 'm' },
          { action: 'resume', run: 'r' },
          { action: 'replay', run: 'r', step: 'implement' },
          { action: 'skipTask', run: 'r', task: 't' },
          { action: 'stop', run: 'r' },
          { action: 'pause' },
        ],
      }),
    );
    expect(read.ok).toBe(true);
  });

  it('reads an empty message and no actions', () => {
    expect(readResult(backlogTurn, block({ say: '' }))).toEqual({ ok: true, value: { say: '', actions: [] } });
  });

  it('refuses the actions of the owner alone and an unknown action', () => {
    for (const name of ['runMilestone', 'runBacklog', 'runTask', 'addRepository', 'mergeTask', 'nothing']) {
      expect(errorsOf({ say: '', actions: [{ action: name }] })).toEqual([expect.stringContaining('actions.0.action')]);
    }
  });

  it('names the field an action lacks', () => {
    expect(errorsOf({ say: '', actions: [{ action: 'closeRequirement', id: 'M1.R1' }] })).toEqual([
      'actions.0: closeRequirement needs evidence',
    ]);
  });

  it('needs a say that is text, or none', () => {
    expect(readResult(backlogTurn, block({ actions: [] }))).toEqual({ ok: true, value: { say: '', actions: [] } });
    expect(errorsOf({ say: 3, actions: [] })).toEqual([expect.stringContaining('say')]);
  });

  it('tells the agent that say is plain words', () => {
    expect(resultPrompt(backlogTurn)).toContain('- say (string, optional): A message for the person in plain words');
  });
});
