import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { rebaseFeatureRepos } from '../git/rebase';
import { memoryJournal } from '../git/rebase/journal.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { createFlowHarness } from './flow-harness';
import type { FakeHostSettings } from './fake-host-rules';
import { featureWorktree, git } from './runs.spec-helpers';

const KEY = 'PROJ-620';
const FEATURE = `feature/${KEY}-ship-the-field`;
const IDENTITY = '%an <%ae>|%cn <%ce>';

/** Who the commits of a run are made as, and how a CI rerun is asked for, with only the run's person and the host's answer set. */
describe('the person of a run is the author and committer of its commits', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    await flow.close();
    jest.restoreAllMocks();
  });

  async function start(person: string | null, fakeHost?: FakeHostSettings): Promise<void> {
    flow = await createFlowHarness(KEY, { realHost: true, realSteps: ['branch', 'commit'], fakeHost });
    const run = await flow.begin('plan');
    const runs = flow.app.app.get(RunRepository);
    await runs.saveRun({ ...run, startedBy: person });
    const registry = flow.app.app.get(CodeHostRegistry);
    jest.spyOn(registry, 'forRun').mockResolvedValue(registry);
    jest.spyOn(registry, 'requiredCredentials').mockReturnValue(flow.host.selected());
  }

  async function commitOne(): Promise<string> {
    await flow.app.pipeline.step('branch', KEY);
    mkdirSync(join(flow.tree, 'src'), { recursive: true });
    writeFileSync(join(flow.tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await flow.app.pipeline.step('commit', KEY);
    return git(flow.tree, ['log', '-1', `--format=${IDENTITY}`]);
  }

  it('shows the person with the no-reply address of the host as author and committer', async () => {
    await start('ann');
    const ann = '1+ann@users.noreply.gitlab.example';
    expect(await commitOne()).toBe(`ann <${ann}>|ann <${ann}>`);
  });

  it("shows the address the host gives when it has no no-reply one, with the person's name", async () => {
    await start('ann', { author: { name: 'Ann Lee', email: 'ann@example.com' } });
    expect(await commitOne()).toBe('Ann Lee <ann@example.com>|Ann Lee <ann@example.com>');
  });

  it("keeps today's server identity for a run with no person", async () => {
    await start(null);
    const own = `${git(flow.tree, ['config', 'user.name'])} <${git(flow.tree, ['config', 'user.email'])}>`;
    expect(await commitOne()).toBe(`${own}|${own}`);
  });

  it("keeps today's server identity when the host gives no address at all", async () => {
    await start('ann', { author: 'none' });
    const own = `${git(flow.tree, ['config', 'user.name'])} <${git(flow.tree, ['config', 'user.email'])}>`;
    expect(await commitOne()).toBe(`${own}|${own}`);
  });

  it('asks the host to run the failed jobs again on a pushed head, and adds no commit', async () => {
    await start('ann');
    await commitOne();
    const head = git(flow.tree, ['rev-parse', 'HEAD']);
    flow.host.ci.failBranch(FEATURE, 'boom');
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    await flow.app.app.get(DocumentRepository).putDocument(run, 'ci_rerun', `demo ${head} -> ${head}\n`);
    const result = await flow.app.pipeline.step('commit', KEY);
    expect(result.exitCode).toBe(0);
    expect(flow.host.reruns).toEqual([{ project: 'group/demo', id: 9 }]);
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('the commit of a rebase', () => {
  it('gives the rebased commit the person as author and committer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-author-rebase-'));
    const { tree, clone } = featureWorktree(root, 'proj-64');
    const branch = 'feature/proj-64-ship-the-field';
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(tree, ['push', '-u', 'origin', branch]);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'README.md'), 'moved\n');
    git(clone, ['add', 'README.md']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const stop = await rebaseFeatureRepos({
      root,
      key: 'proj-64',
      repos: ['demo'],
      branch,
      prompt: null,
      denied: [],
      message: 'feat(proj-64): Ship the field',
      author: { name: 'Ann Lee', email: 'ann@example.com' },
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
      journal: memoryJournal(),
    });
    expect(stop.kind).toBe('clean');
    expect(git(tree, ['log', '-1', `--format=${IDENTITY}`])).toBe(
      'Ann Lee <ann@example.com>|Ann Lee <ann@example.com>',
    );
  });
});
