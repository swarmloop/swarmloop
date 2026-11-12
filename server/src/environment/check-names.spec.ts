import { checkNames } from './check-names';

describe('checkNames', () => {
  it('labels a command by its tool and first arguments', () => {
    expect(checkNames(['npm test server', 'eslint --max-warnings 0 .', 'npm run build --prefix server'])).toEqual([
      'npm test server',
      'eslint',
      'npm run build',
    ]);
  });

  it('uses a given name as written', () => {
    expect(checkNames([{ run: 'npm test', name: 'server tests' }])).toEqual(['server tests']);
  });

  it('cuts a label to 24 characters', () => {
    const [name] = checkNames(['some-very-long-tool-name-here another']);
    expect(name).toHaveLength(24);
  });

  it('falls back to the start of a command with no plain first word', () => {
    expect(checkNames(['./scripts/check.sh --all'])).toEqual(['./scripts/check.sh --all']);
    expect(checkNames(['$(cat cmd) --x'])).toEqual(['$(cat cmd) --x']);
  });

  it('keeps names unique within a list, inside 24 characters', () => {
    expect(checkNames(['npm test a', 'npm test a --x', { run: 'x', name: 'npm test a' }])).toEqual([
      'npm test a',
      'npm test a 2',
      'npm test a 3',
    ]);
    const long = 'x'.repeat(30);
    const names = checkNames([long, long]);
    expect(names[1]).toHaveLength(24);
    expect(new Set(names).size).toBe(2);
  });

  it('may repeat a name across two lists', () => {
    expect(checkNames(['npm test'])).toEqual(checkNames(['npm test']));
  });
});
