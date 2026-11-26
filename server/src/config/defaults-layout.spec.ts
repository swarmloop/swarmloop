import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDefaultsLayout } from './defaults-layout';
import { parseEnvFile } from './default-settings';
import { resolveRepoRoot } from './repo-root';

describe('parseDefaultsLayout', () => {
  it('makes a group per blank-line block, headed by its first comment line', () => {
    const groups = parseDefaultsLayout('# First.\n# One.\nA=1\n\n# Second.\n# Two.\nB=2\n');
    expect(groups.map(({ name, settings }) => [name, settings.map(({ name: setting }) => setting)])).toEqual([
      ['First.', ['A']],
      ['Second.', ['B']],
    ]);
  });

  it('describes a name by the comment lines between it and the heading or the setting before it', () => {
    const [group] = parseDefaultsLayout('# Heading.\n# Does one.\n# Does it twice.\nA=1\nB=2\n# Does C.\nC=3\n');
    expect(group.settings).toEqual([
      { name: 'A', description: 'Does one. Does it twice.' },
      { name: 'B' },
      { name: 'C', description: 'Does C.' },
    ]);
  });

  it('gives a block that opens with a setting an empty group name', () => {
    expect(parseDefaultsLayout('A=1\n')).toEqual([{ name: '', settings: [{ name: 'A' }] }]);
  });

  it('lists every setting of the real defaults.env once, in its order', () => {
    const text = readFileSync(join(resolveRepoRoot(undefined, __dirname), 'defaults.env'), 'utf8');
    const listed = parseDefaultsLayout(text).flatMap(({ settings }) => settings.map(({ name }) => name));
    expect(listed).toEqual(Object.keys(parseEnvFile(text)));
  });
});
