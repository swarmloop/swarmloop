import { ERROR_CODES } from '../contract/error-codes';
import { GitRulesError } from './swarmloop-error';

describe('GitRulesError', () => {
  it('names the host message and the refused name, and says where the rule goes', () => {
    const error = new GitRulesError('title must start with a ticket', 'feat: add x');
    expect(error.message).toBe('title must start with a ticket refuses feat: add x');
    expect(error.code).toBe(ERROR_CODES.GIT_RULES);
    expect(error.category).toBe('user');
    expect(error.hint).toBe('put the rule into .swarmloop.json');
  });
});
