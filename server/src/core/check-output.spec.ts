import { checkOutputPath, isCheckOutputOf } from './check-output';

describe('check output files', () => {
  it('names the file from the run, step, attempt and command and keeps it in data', () => {
    expect(checkOutputPath('/srv', 'PROJ-1', 'checks', 'att-1', 3)).toBe(
      '/srv/data/PROJ-1-checks-att-1-command-3-log.txt',
    );
    expect(isCheckOutputOf('PROJ-1-checks-att-1-command-3-log.txt', 'PROJ-1')).toBe(true);
  });

  it('refuses a part that could leave data/', () => {
    for (const attempt of ['../x', 'a/b', 'a\\b']) {
      expect(() => checkOutputPath('/srv', 'PROJ-1', 'checks', attempt, 0)).toThrow('invalid');
    }
    expect(() => checkOutputPath('/srv', 'PROJ-1', 'checks', 'a', -1)).toThrow('invalid');
  });
});
