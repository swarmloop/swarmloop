import { SwarmloopError } from '../../swarmloop-error';
import { branchName, commitMessage } from './branch-name';

describe('branchName', () => {
  it('uses the Jira key and a kebab summary', () => {
    expect(branchName('PROJ-12', 'Ship the field')).toBe('feature/PROJ-12-ship-the-field');
  });

  it('uses a slug run id the same way', () => {
    expect(branchName('vendor-api', 'Add plot types')).toBe('feature/vendor-api-add-plot-types');
  });

  it('transliterates a Ukrainian summary', () => {
    expect(branchName('PROJ-7', 'додати поле до форми')).toBe('feature/PROJ-7-dodaty-pole-do-formy');
  });

  it('writes a GitLab subject from the Jira key, not the run id', () => {
    expect(commitMessage('PROJ-20--5', 'Ship the field.')).toBe('feat(PROJ-20): Ship the field');
  });

  it('rejects a summary that has no name', () => {
    expect(() => branchName('PROJ-12', '---')).toThrow(SwarmloopError);
    expect(() => branchName('PROJ-12', '---')).toThrow('branch name is missing');
  });
});
