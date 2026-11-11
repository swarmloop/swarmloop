import { ERROR_CODES } from './error-codes';
import { actionsFor } from './run-state';

describe('actionsFor a block that a person can fix', () => {
  it.each([
    ERROR_CODES.DISK_LOW,
    ERROR_CODES.WORKSPACE_LOST,
    ERROR_CODES.BRANCH_IN_USE,
    ERROR_CODES.BRANCH_DIVERGED,
    ERROR_CODES.SUBTASK_BLOCKED,
  ])('offers Resume after %s', (code) => {
    expect(actionsFor('blocked', code)).toEqual(['resume', 'replay']);
  });
});

describe('actionsFor a split run between passes', () => {
  it.each([ERROR_CODES.SUBTASKS_RUNNING, ERROR_CODES.SUBTASK_WAITING])('offers Stop and Resume while %s', (code) => {
    expect(actionsFor('waiting', code)).toEqual(['stop', 'resume', 'replay', 'rebase']);
  });
});
