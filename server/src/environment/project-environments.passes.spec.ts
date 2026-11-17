import { basename } from 'path';
import type { RunEntity } from '../history/entities';
import { writeFiles } from '../git/git-repo.spec-helpers';
import { manifest, setup } from './project-environments.spec-helpers';

const SERVER = 'npm test --prefix server';
const AT = '2026-01-01T00:00:00.000Z';
interface StoredEnvironment {
  config: { checks: { name: string }[]; setup?: string; hosts?: unknown };
}

const entries = [
  { run: SERVER, name: 'server tests', paths: ['server/'] },
  { run: 'npm test --prefix dashboard', name: 'dashboard tests', paths: ['dashboard/'] },
  'npm run lint',
];

describe('checks that passed on the same files', () => {
  /** A run that passed its commands once with `server/a.ts` changed, and a way to start the next visit. */
  async function afterFirstVisit(options: Parameters<typeof setup>[0] = {}) {
    const made = setup({ writes: true, config: { ...manifest, checks: entries }, ...options });
    const repo = made.input.mounts[0].hostPath;
    const key = basename(repo);
    writeFiles(repo, { 'server/a.ts': 'a\n' });
    await made.service.check(made.input);
    const visit = (run: Partial<RunEntity> = {}, named: { repo: string; command: string; tail: string }[] = []) =>
      made.service.check({ ...made.input, run: run as RunEntity }, named);
    const statuses = () => made.rows.slice(-3).map((row) => row.status);
    const stateOf = (kind: string) => made.stored.filter((item) => item.kind === `${kind}:${key}`);
    /** Stores a changed copy of the last document of a kind, as a later write of that kind would. */
    const rewrite = <Body>(kind: string, edit: (body: Body) => void) => {
      const body = JSON.parse(stateOf(kind).at(-1)?.body ?? '{}') as Body;
      edit(body);
      made.stored.push({ kind: `${kind}:${key}`, body: JSON.stringify(body) });
    };
    return { ...made, repo, key, visit, statuses, stateOf, rewrite };
  }

  it('skips it when a return changes only files outside its paths, and counts it as passed', async () => {
    const run = await afterFirstVisit();
    expect(run.statuses()).toEqual(['passed', 'skipped', 'passed']);
    writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
    const done = await run.visit();
    expect(done).toEqual({ passed: 3, total: 3 });
    expect(run.statuses()).toEqual(['skipped', 'passed', 'passed']);
    const reason = `passed on these files at ${AT}`;
    expect(run.stored.map((item) => item.body)).toContain(
      JSON.stringify({
        repo: run.key,
        command: SERVER,
        name: 'server tests',
        skipped: true,
        exitCode: 0,
        tail: reason,
      }),
    );
    expect(run.live.log).toHaveBeenCalledWith(expect.objectContaining({ body: `server tests: ${reason}\n` }));
    expect(JSON.parse(run.stateOf('checks_skipped').at(-1)?.body ?? '{}')).toEqual({
      names: ['server tests'],
      passed: { 'server tests': reason },
    });
  });

  it.each([
    ['edits a tracked file under its paths', { 'server/a.ts': 'changed\n' }],
    ['adds an untracked file under its paths', { 'server/c.ts': 'c\n' }],
  ])('runs it when a return %s', async (_label, files) => {
    const run = await afterFirstVisit();
    writeFiles(run.repo, { ...files, 'dashboard/b.ts': 'b\n' });
    await run.visit();
    expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
  });

  it('runs a command without paths on every visit', async () => {
    const run = await afterFirstVisit();
    writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
    const before = run.spawned.length;
    await run.visit();
    expect(run.rows.at(-1)).toMatchObject({ command: 'npm run lint', status: 'passed' });
    expect(run.spawned.slice(before).filter((launch) => launch.allowHosts.length === 0)).toHaveLength(2);
  });

  describe('runs it again when', () => {
    it.each([
      ['the run has a new generation', { generation: 2 }],
      ['the last return named it', {}, [{ repo: '', command: SERVER, tail: '' }]],
    ])('%s', async (_label, current, named = []) => {
      const run = await afterFirstVisit();
      writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
      await run.visit(
        current,
        named.map((item) => ({ ...item, repo: run.key })),
      );
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });

    it('the image id is another one', async () => {
      let id = 'sha256:aaaa\n';
      const run = await afterFirstVisit({ imageId: () => id });
      id = 'sha256:bbbb\n';
      writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
      await run.visit();
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });

    it.each([
      ['its entry changed', (body: StoredEnvironment) => (body.config.checks[0].name = 'server unit tests')],
      ['the setup changed', (body: StoredEnvironment) => (body.config.setup = 'npm ci --ignore-scripts')],
      ['the hosts changed', (body: StoredEnvironment) => (body.config.hosts = { agent: ['pub.dev'] })],
    ])('%s', async (_label, edit) => {
      const run = await afterFirstVisit();
      run.rewrite<StoredEnvironment>('environment', edit);
      writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
      await run.visit();
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });

    it('it failed in the last visit, although its files are the ones it passed on', async () => {
      let failing = false;
      const run = await afterFirstVisit({ checkExit: (command) => (failing && command === SERVER ? 1 : 0) });
      failing = true;
      writeFiles(run.repo, { 'server/a.ts': 'broken\n' });
      await expect(run.visit()).rejects.toThrow('required check failed');
      failing = false;
      writeFiles(run.repo, { 'server/a.ts': 'a\n', 'dashboard/b.ts': 'b\n' });
      await run.visit();
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });

    it.each([
      ['its kept tree is missing from the repository', '0123456789abcdef0123456789abcdef01234567'],
      ['git cannot read its kept tree', 'not-a-tree'],
    ])('%s', async (_label, tree) => {
      const run = await afterFirstVisit();
      run.rewrite<{ commands: Record<string, { tree: string }> }>(
        'command_passes',
        (body) => (body.commands[SERVER].tree = tree),
      );
      writeFiles(run.repo, { 'dashboard/b.ts': 'b\n' });
      await run.visit();
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });
  });

  describe('a change outside every paths list', () => {
    it.each([
      ['a changed manifest', { '.swarmloop.json': '{}\n' }],
      ['a new root lockfile', { 'package-lock.json': '{}\n' }],
    ])('runs every command in a first visit: %s', async (_label, files) => {
      const made = setup({ writes: true, config: { ...manifest, checks: entries } });
      writeFiles(made.input.mounts[0].hostPath, files);
      await made.service.check(made.input);
      expect(made.rows.map((row) => row.status)).toEqual(['passed', 'passed', 'passed']);
    });

    it.each([
      ['a changed manifest', { '.swarmloop.json': '{}\n' }],
      ['a new root lockfile', { 'package-lock.json': '{}\n' }],
    ])('runs every command in a later visit: %s', async (_label, files) => {
      const run = await afterFirstVisit();
      writeFiles(run.repo, files);
      await run.visit();
      expect(run.statuses()).toEqual(['passed', 'passed', 'passed']);
    });
  });
});
