import { SwarmloopError } from '../swarmloop-error';
import { originRef, promptBase } from './base-ref';

describe('prompt base ref', () => {
  it('reads one branch line and strips an origin prefix', () => {
    expect(promptBase('https://example/browse/PROJ-1\nbranch: feature/PROJ-1-field\n')).toEqual({
      kind: 'named',
      name: 'feature/PROJ-1-field',
    });
    expect(promptBase('branch: origin/feature/PROJ-1-field')).toEqual({ kind: 'named', name: 'feature/PROJ-1-field' });
    expect(originRef('feature/PROJ-1-field')).toBe('origin/feature/PROJ-1-field');
  });

  it('uses the default base when the prompt has no branch line', () => {
    expect(promptBase(null)).toEqual({ kind: 'default' });
    expect(promptBase('ship the field\nsee the branch later')).toEqual({ kind: 'default' });
  });

  it('rejects two lines, a blank line, and an unsafe name', () => {
    expect(() => promptBase('branch: feature/a\nbranch: feature/b\n')).toThrow(SwarmloopError);
    expect(() => promptBase('branch: feature/a\nbranch: feature/b\n')).toThrow('branch is ambiguous');
    expect(() => promptBase('branch:')).toThrow('branch is invalid');
    expect(() => promptBase('branch: feature/foo bar')).toThrow('branch is invalid');
    expect(() => promptBase('branch: feature/../main')).toThrow('branch is invalid');
    expect(() => promptBase('branch: -feature')).toThrow('branch is invalid');
    expect(() => promptBase('branch: /feature')).toThrow('branch is invalid');
    expect(() => promptBase('branch: feature/foo~1')).toThrow('branch is invalid');
  });
});
