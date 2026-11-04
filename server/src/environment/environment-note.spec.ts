import { environmentNote, withEnvironment } from './environment-note';
import type { EnvironmentRecord } from './project-environments';

const record: EnvironmentRecord = {
  repo: 'shop',
  image: 'swarmloop-env-shop:0123456789ab',
  config: { source: '.swarmloop.json', setup: 'npm ci', cache: [], checks: ['npm test', 'npm run lint'] },
};

describe('environmentNote', () => {
  it('names the image, the checks and the CI rule', () => {
    const note = environmentNote(record);
    expect(note).toContain('swarmloop-env-shop:0123456789ab from .swarmloop.json of shop');
    expect(note).toContain('- `npm test`\n- `npm run lint`');
    expect(note).toContain('.github/workflows/');
    expect(note).not.toContain('setup `npm ci` failed');
    expect(note).toContain('run the setup again: `npm ci`');
    expect(note).toContain('narrowest command');
  });

  it('asks the agent to find the checks when the repository names none', () => {
    expect(environmentNote({ ...record, config: { ...record.config, checks: [] } })).toContain('names no checks');
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
  it('drops the ban on tests and appends the note', () => {
    const prompt =
      'Edit only that path. Do not start a service, a database, or the application. Do not run tests. Do not commit. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.\nDo not start a service, a database, or the application. Do not run tests on this machine.';
    const text = withEnvironment(prompt, 'NOTE');
    expect(text).not.toContain('Do not run tests');
    expect(text).not.toContain('never in this sandbox');
    expect(text).toContain('Do not start a service, a database, or the application. Do not commit.');
    expect(text.endsWith('\n\nNOTE\n')).toBe(true);
  });
});
