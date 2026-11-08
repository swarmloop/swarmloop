import { ERROR_CODES } from './error-codes';
import { actionsFor } from './run-state';

describe('actionsFor a block that a person can fix', () => {
  it.each([ERROR_CODES.DISK_LOW, ERROR_CODES.WORKSPACE_LOST, ERROR_CODES.BRANCH_IN_USE, ERROR_CODES.BRANCH_DIVERGED])(
    'offers Resume after %s',
    (code) => {
      expect(actionsFor('blocked', code)).toEqual(['resume', 'replay']);
    },
  );
});
