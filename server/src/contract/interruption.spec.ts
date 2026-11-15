import { interruptionSentence, readInterruption, type InterruptionNote } from './interruption';

const time = () => '21:29';
const at = '2026-11-14T20:29:00.000Z';

describe('interruptionSentence', () => {
  it('says the step starts again by itself when relaunched', () => {
    expect(interruptionSentence({ at, relaunched: true }, time)).toBe(
      'Interrupted at 21:29 by a server restart. The server starts this step again by itself. Nothing to do.',
    );
  });

  it('names the launch limit', () => {
    expect(interruptionSentence({ at, relaunched: false, cause: 'limit', limit: 3 }, time)).toBe(
      'Interrupted at 21:29 by a server restart. Not started again: the launch limit of 3 was reached. Resume, Replay or Skip.',
    );
  });

  it('names a pending stop', () => {
    expect(interruptionSentence({ at, relaunched: false, cause: 'stop' }, time)).toBe(
      'Interrupted at 21:29 by a server restart. Not started again: a stop was pending. Resume, Replay or Skip.',
    );
  });
});

describe('interruptionSentence for a start that did not go through', () => {
  it('says the server could not start the step', () => {
    expect(interruptionSentence({ at, relaunched: false, cause: 'start' }, time)).toBe(
      'Interrupted at 21:29 by a server restart. Not started again: the server could not start it. Resume, Replay or Skip.',
    );
  });
});

describe('readInterruption', () => {
  it('reads a stored body', () => {
    const note: InterruptionNote = { at, relaunched: false, cause: 'limit', limit: 3 };
    expect(readInterruption(JSON.stringify(note))).toEqual(note);
  });

  it('reads the start cause and refuses an unknown one', () => {
    expect(readInterruption(JSON.stringify({ at, relaunched: false, cause: 'start' }))).toEqual({
      at,
      relaunched: false,
      cause: 'start',
    });
    expect(readInterruption(JSON.stringify({ at, relaunched: false, cause: 'other' }))).toBeNull();
  });

  it('returns null for a damaged body', () => {
    expect(readInterruption('{not json')).toBeNull();
    expect(readInterruption('{"at":1}')).toBeNull();
  });
});
