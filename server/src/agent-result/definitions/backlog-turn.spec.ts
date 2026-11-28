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
          { action: 'changeTask', task: 'a', revision: 0, description: 'new' },
          { action: 'closeRequirement', id: 'M1.R1', evidence: 'merged' },
          { action: 'answerRun', run: 'r', answers: [{ body: 'yes' }] },
          { action: 'planChat', run: 'r', message: 'm' },
          { action: 'passQuestion', run: 'r', question: 'q', reason: 'Only you can choose.' },
          { action: 'resume', run: 'r' },
          { action: 'replay', run: 'r', step: 'implement', instruction: 'Fix it.' },
          { action: 'rebase', run: 'r' },
          { action: 'skipTask', run: 'r', task: 't' },
          { action: 'stop', run: 'r' },
          { action: 'pause' },
        ],
      }),
    );
    expect(read.ok).toBe(true);
  });

  it('reads a task change and a task delete that name a revision, and refuses a revision that is no count', () => {
    expect(
      errorsOf({
        say: '',
        actions: [
          { action: 'changeTask', task: 'a', revision: 2, title: 'T' },
          { action: 'deleteTask', task: 'a', revision: 2 },
        ],
      }),
    ).toEqual([]);
    for (const revision of ['two', -1, 1.5]) {
      expect(errorsOf({ say: '', actions: [{ action: 'changeTask', task: 'a', revision }] })).toEqual([
        expect.stringContaining('actions.0.revision'),
      ]);
    }
  });

  it('names the revision a task change or a task delete lacks', () => {
    expect(errorsOf({ say: '', actions: [{ action: 'changeTask', task: 'a', title: 'T' }] })).toEqual([
      'actions.0: changeTask needs revision',
    ]);
    expect(errorsOf({ say: '', actions: [{ action: 'deleteTask', task: 'a' }] })).toEqual([
      'actions.0: deleteTask needs revision',
    ]);
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

  it('refuses a replay without an instruction and reads a rebase of a run', () => {
    expect(errorsOf({ say: '', actions: [{ action: 'replay', run: 'r', step: 'implement' }] })).toEqual([
      'actions.0: replay needs instruction',
    ]);
    expect(errorsOf({ say: '', actions: [{ action: 'rebase', run: 'r' }] })).toEqual([]);
  });

  it('refuses a pass-on with no reason and reads one that names no question', () => {
    expect(errorsOf({ say: '', actions: [{ action: 'passQuestion', run: 'r' }] })).toEqual([
      'actions.0: passQuestion needs reason',
    ]);
    expect(errorsOf({ say: '', actions: [{ action: 'passQuestion', run: 'r', reason: 'Yours.' }] })).toEqual([]);
  });

  it('needs a say that is text, or none', () => {
    expect(readResult(backlogTurn, block({ actions: [] }))).toEqual({ ok: true, value: { say: '', actions: [] } });
    expect(errorsOf({ say: 3, actions: [] })).toEqual([expect.stringContaining('say')]);
  });

  it('tells the agent that say is plain words', () => {
    expect(resultPrompt(backlogTurn)).toContain('- say (string, optional): A message for the person in plain words');
  });
});
