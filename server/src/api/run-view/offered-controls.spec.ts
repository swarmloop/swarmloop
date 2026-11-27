import type { DocumentEntity, RunEntity } from '../../history/entities';
import { COMMAND_TYPES } from '../../contract/command';
import { interruptionSentence } from '../../contract/interruption';
import { actionsFor } from '../../contract/run-state';
import { stateOfStatus, storedState } from '../../history/run-state';
import { parkedConflictIn } from '../../pipeline/parked-conflict';
import { sentence } from './flow-waiting';

describe('the controls a sentence names are offered in the state that shows it', () => {
  it("offers Replay in the state of a closed run, whose sentence says 'Replay starts it again.'", () => {
    const ended = {
      status: 'done',
      currentStep: 'done',
      mergeOutcome: JSON.stringify({ closed: { repo: 'api', by: null, at: 't' } }),
    } as RunEntity;
    const closed = { ...ended, ...stateOfStatus(ended) };
    const { state } = storedState(closed);
    expect(state).toBe('closed');
    expect(sentence(closed, [], [], [], 3)).toContain('Replay starts it again.');
    expect(actionsFor(state)).toContain('replay');
  });

  it('offers Resume in the state of a parked REBASE_CONFLICT block, whose sentence names Resume', () => {
    const parked = {
      status: 'blocked',
      currentStep: 'implement',
      generation: 2,
      stateReason: JSON.stringify({ code: 'REBASE_CONFLICT', message: 'm' }),
    } as RunEntity;
    const blocked = { ...parked, ...stateOfStatus(parked) };
    const documents = [
      { kind: 'rebase_conflict', body: 'pending-implement\n' },
      {
        kind: 'rebase_journal',
        body: JSON.stringify({ app: { path: '/w', branch: 'b', checkpoint: 'conflict', generation: 2 } }),
      },
    ] as DocumentEntity[];
    const parkedConflict = parkedConflictIn(documents, blocked);
    expect(sentence(blocked, [], documents, [], 3)).toContain('Resume has the implement agent resolve it');
    expect(actionsFor('blocked', 'REBASE_CONFLICT', { parkedConflict })).toContain('resume');
  });

  it.each(['idle', 'failed', 'stopped'] as const)(
    'offers Resume and Replay in a %s run, and Skip is a command, for an interrupted step that is not started again',
    (state) => {
      const said = interruptionSentence(
        { at: '2026-11-12T14:05:00.000Z', relaunched: false, cause: 'stop' },
        (iso) => iso,
      );
      expect(said).toContain('Resume, Replay or Skip');
      expect(actionsFor(state)).toEqual(expect.arrayContaining(['resume', 'replay']));
      expect(COMMAND_TYPES).toContain('skip');
    },
  );
});
