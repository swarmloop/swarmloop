import { ERROR_CODES } from './error-codes';
import { actionsFor, AUTO_RETRY_CODES, NEEDS_PERSON, REASON } from './run-state';

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
  it.each([ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.DOCKER_UNAVAILABLE])(
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
