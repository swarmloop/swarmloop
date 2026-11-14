import { ERROR_CODES } from './error-codes';
import {
  actionsFor,
  AUTO_RETRY_CODES,
  NEEDS_ANSWERS,
  NEEDS_PERSON,
  REASON,
  REASON_WORDS,
  RUN_STATES,
  STATE_WORDS,
  stateWord,
} from './run-state';

describe('actionsFor a block that a person can fix', () => {
  it.each([
    ERROR_CODES.DISK_LOW,
    ERROR_CODES.WORKSPACE_LOST,
    ERROR_CODES.BRANCH_IN_USE,
    ERROR_CODES.BRANCH_DIVERGED,
    ERROR_CODES.SUBTASK_BLOCKED,
    ERROR_CODES.TEST_FLAKY,
  ])('offers Resume after %s', (code) => {
    expect(actionsFor('blocked', code)).toEqual(['resume', 'replay']);
  });
});

describe('actionsFor a split run between passes', () => {
  it.each([ERROR_CODES.SUBTASKS_RUNNING, ERROR_CODES.SUBTASK_WAITING])('offers Stop and Resume while %s', (code) => {
    expect(actionsFor('waiting', code)).toEqual(['stop', 'resume', 'replay', 'rebase']);
  });
});

describe('actionsFor the codes with a next try or a limit', () => {
  it.each([ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.CI_NOT_STARTED, ERROR_CODES.DOCKER_UNAVAILABLE])(
    'offers Stop, Resume (try now), Replay and Rebase while waiting on %s',
    (code) => {
      expect(actionsFor('waiting', code)).toEqual(['stop', 'resume', 'replay', 'rebase']);
    },
  );

  it.each([ERROR_CODES.SPEND_LIMIT, ERROR_CODES.PIPELINE_UNFIXED, REASON.loopLimit])(
    'offers Resume after a block on %s',
    (code) => {
      expect(actionsFor('blocked', code)).toEqual(['resume', 'replay']);
    },
  );
});

describe('actionsFor codes that did not change', () => {
  it('keeps a blocked docker, a missing image and an unknown resource as they were', () => {
    expect(actionsFor('blocked', ERROR_CODES.DOCKER_UNAVAILABLE)).toEqual(['resume', 'replay']);
    expect(actionsFor('blocked', ERROR_CODES.IMAGE_MISSING)).toEqual(['resume', 'replay']);
    expect(actionsFor('blocked', ERROR_CODES.RESOURCE_UNKNOWN)).toEqual(['replay']);
  });

  it('keeps the runtime limit and git auth waits as they were', () => {
    expect(actionsFor('waiting', ERROR_CODES.RUNTIME_LIMIT)).toEqual(['resume', 'replay', 'rebase']);
    expect(actionsFor('waiting', ERROR_CODES.GIT_AUTH)).toEqual(['resume', 'replay', 'rebase']);
    expect(actionsFor('waiting', 'NEEDS_ANSWERS')).toEqual(['answer', 'replay', 'rebase']);
    expect(actionsFor('failed', ERROR_CODES.STEP_FAILED)).toEqual(['resume', 'replay', 'rebase']);
  });
});

describe('the sweep of every reason code', () => {
  /** Codes that name a state or an internal refusal, not a stop that needs a person or an automatic next try. */
  const NEITHER: readonly string[] = [
    REASON.returned,
    REASON.recovering,
    REASON.mergeWatchUnavailable,
    REASON.mergeWatchStopped,
    REASON.skipped,
    ERROR_CODES.RUN_BUSY,
    ERROR_CODES.REVISION_CONFLICT,
    ERROR_CODES.SESSION_INCOMPATIBLE,
    ERROR_CODES.AGENT_ENDED_EARLY,
    ERROR_CODES.AGENT_LOOPING,
  ];

  it.each([...new Set([...Object.values(ERROR_CODES), ...Object.values(REASON)])])('classifies %s', (code) => {
    const listed = [code in NEEDS_PERSON, AUTO_RETRY_CODES.includes(code), NEITHER.includes(code)];
    expect(listed.filter(Boolean)).toHaveLength(1);
  });

  it('names the action a person takes for every code that needs one', () => {
    for (const action of Object.values(NEEDS_PERSON)) {
      expect(['resume', 'replay', 'rebase', 'answer']).toContain(action);
    }
  });
});

describe('actionsFor a skipped task', () => {
  it('offers no Resume, Replay or Rebase', () => {
    expect(actionsFor('skipped', REASON.skipped)).toEqual([]);
  });
});

describe('stateWord', () => {
  const time = (iso: string): string => `T(${iso})`;
  const word = (
    state: (typeof RUN_STATES)[number],
    reason: { code: string; message?: string; [k: string]: unknown } | null = null,
    facts = {},
  ) => stateWord(state, reason ? { message: 'why', ...reason } : null, facts, time);

  it.each(RUN_STATES)('has a word for the state %s', (state) => {
    expect(STATE_WORDS[state].word).not.toBe('');
    expect(word(state).word).not.toMatch(/^waiting$/i);
  });

  it.each([...Object.values(ERROR_CODES), ...Object.values(REASON), NEEDS_ANSWERS])(
    'has an entry for the reason %s and reads a word in every state',
    (code) => {
      expect(Object.keys(REASON_WORDS)).toContain(code);
      for (const state of RUN_STATES) {
        const view = word(state, { code });
        expect(view.word).not.toMatch(/^(waiting|implement|plan|research|code review)$/i);
        expect(view.tone === 'person').toBe(view.word === 'Waiting for you');
      }
    },
  );

  it('has an entry for exactly the known reason codes, none left to a default', () => {
    const known = new Set<string>([...Object.values(ERROR_CODES), ...Object.values(REASON), NEEDS_ANSWERS]);
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...known].sort());
  });

  it('reads Retrying at <time> for a host or docker that is down', () => {
    for (const code of [ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.DOCKER_UNAVAILABLE]) {
      expect(word('waiting', { code, retryAt: '2026-01-01T10:00:00Z' }).word).toBe(
        'Retrying at T(2026-01-01T10:00:00Z)',
      );
    }
  });

  it('reads Paused until <time> for a runtime limit', () => {
    const limit = { runtime: 'r', resumesAt: '2026-01-01T11:00:00Z' };
    expect(word('waiting', { code: ERROR_CODES.RUNTIME_LIMIT, limit }).word).toBe(
      'Paused until T(2026-01-01T11:00:00Z)',
    );
  });

  it('reads Waiting for subtasks while the subtasks work', () => {
    expect(word('waiting', { code: ERROR_CODES.SUBTASKS_RUNNING }).word).toBe('Waiting for subtasks');
  });

  it.each([ERROR_CODES.SPEND_LIMIT, REASON.loopLimit, ERROR_CODES.PIPELINE_UNFIXED])(
    'reads Blocked with the reason in the tip for %s',
    (code) => {
      expect(word('blocked', { code, message: 'the reason' })).toMatchObject({
        word: 'Blocked',
        tone: 'error',
        tip: 'the reason',
      });
    },
  );

  it('reads Waiting for you in the person tone, and only that', () => {
    expect(word('waiting', { code: NEEDS_ANSWERS })).toMatchObject({ word: 'Waiting for you', tone: 'person' });
    expect(RUN_STATES.filter((state) => STATE_WORDS[state].tone === 'person')).toEqual(['waiting']);
  });

  it('says who merged and when in the tip of a merged run', () => {
    const merge = {
      merged: {
        a: { sha: 'x', by: 'ann', at: '2026-01-01T09:00:00Z', url: null },
        b: { sha: 'y', by: 'ann', at: '2026-01-01T10:00:00Z', url: null },
      },
    };
    expect(word('done', null, { merge })).toMatchObject({
      word: 'Merged',
      tone: 'done',
      tip: 'Merged by ann, T(2026-01-01T10:00:00Z)',
    });
  });

  it('reads Ready to merge, Queued for a subtask and Closed for a done run', () => {
    expect(word('done').word).toBe('Ready to merge');
    expect(word('done', null, { subtask: true, mergeWait: 'CI runs' })).toMatchObject({
      word: 'Queued to merge into the epic',
      tip: 'CI runs',
    });
    const merge = { closed: { repo: 'r', by: 'bo', at: '2026-01-01T09:00:00Z' } };
    expect(word('done', null, { merge })).toMatchObject({
      word: 'Closed',
      tone: 'neutral',
      tip: 'Closed by bo, T(2026-01-01T09:00:00Z)',
    });
  });

  it('gives only the states the server moves on by itself the working tone', () => {
    expect(RUN_STATES.filter((state) => STATE_WORDS[state].tone === 'working')).toEqual([
      'idle',
      'queued',
      'running',
      'stopping',
      'recovering',
    ]);
  });
});
