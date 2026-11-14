import { environmentNote, withEnvironment } from './environment-note';
import type { EnvironmentRecord } from './environment-types';

const record: EnvironmentRecord = {
  repo: 'shop',
  image: 'swarmloop-env-shop:0123456789ab',
  config: { source: '.swarmloop.json', setup: 'npm ci', cache: [], checks: ['npm test', 'npm run lint'] },
};

describe('environmentNote', () => {
  it('names the image, checks and task-scoped CI changes', () => {
    const note = environmentNote(record);
    expect(note).toContain('swarmloop-env-shop:0123456789ab from .swarmloop.json of shop');
    expect(note).toContain('- `npm test`\n- `npm run lint`');
    expect(note).toContain('CI configuration may be changed when required by the task.');
    expect(note).not.toContain('the commit refuses it');
    expect(note).not.toContain('setup `npm ci` failed');
    expect(note).toContain('run the setup again: `npm ci`');
  });

  it('tells implement-improve that the checks already ran and the server gate comes after it', () => {
    const note = environmentNote(record);
    expect(note).toContain('The checks step runs these after your turn:\n- `npm test`\n- `npm run lint`');
  });

  it('keeps the implement note except for the server sentence', () => {
    const note = environmentNote(record);
    expect(note).toContain(
      'The server runs every declared check after the implement-improve pass, before code review;',
    );
  });

  it('asks the agent to find the checks when the repository names none', () => {
    expect(environmentNote({ ...record, config: { ...record.config, checks: [] } })).toContain(
      'The repository names no checks, so the checks step runs none; CI on the pushed branch is the first full check.',
    );
  });

  it('tells the agent nothing about when to run checks, with checks and with none', () => {
    const none = { ...record, config: { ...record.config, checks: [] } };
    for (const note of [environmentNote(record), environmentNote(none)]) {
      for (const phrase of [
        'Run these checks',
        'before your final summary',
        'Run the full checks',
        'narrowest command',
        'run them again',
        'run the failing command',
        'already ran',
        'Run the tests closest',
      ]) {
        expect(note).not.toContain(phrase);
      }
    }
  });

  it('passes on a failed setup with its last lines', () => {
    const note = environmentNote({
      ...record,
      setup: { command: 'npm ci', image: 'x', exitCode: 1, tail: 'npm ERR! lockfile out of date\n' },
    });
    expect(note).toContain('The setup `npm ci` failed with exit 1.');
    expect(note).toContain('npm ERR! lockfile out of date');
  });
});

describe('environmentNote with the registries kept to the setup', () => {
  it('tells the agent it cannot install packages and not to rerun the setup', () => {
    const note = environmentNote({ ...record, config: { ...record.config, network: 'setup' } });
    expect(note).toContain('package registries are not reachable');
    expect(note).not.toContain('run the setup again');
    expect(note).not.toContain('Package registries are reachable');
  });
});

describe('withEnvironment', () => {
  it('preserves explicit task restrictions instead of deleting matching sentences', () => {
    const prompt = 'Task: update docs. Do not run tests. Do not change CI configuration.';
    const text = withEnvironment(prompt, environmentNote(record));
    expect(text.startsWith(prompt)).toBe(true);
    expect(text).toContain('Preserve explicit restrictions from the original task');
    expect(text).toContain('A sandbox test ban copied from those stages into a checklist');
  });

  it('names the hosts of the manifest besides the registries, and only for an agent that has registries', () => {
    const withHosts = (config: object): EnvironmentRecord => ({
      ...record,
      config: { ...record.config, hosts: { agent: ['pub.dev', 'storage.googleapis.com'] }, ...config },
    });
    expect(environmentNote(withHosts({}))).toContain(
      'Package registries are reachable, and so are these hosts: pub.dev, storage.googleapis.com, so you can add or update a dependency;',
    );
    expect(environmentNote(withHosts({ hosts: { setup: ['pub.dev'] } }))).toBe(environmentNote(record));
  });
});
