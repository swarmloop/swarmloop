import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { git } from './git-fixture';
import { featureWorktree } from './runs.spec-helpers';

const TICKET = 'PROJ-610';
const TODAY = `feature/${TICKET}-ship-the-field`;
const CONVENTIONAL = { '.commitlintrc.json': '{}\n' };

/** What a run's names are, from the branch step to the commit on the branch, with only the repository's files set. */
describe('the names of a run follow the rules of its repository', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let key = TICKET;

  afterEach(async () => {
    await flow.close();
  });

  async function start(repoFiles: Record<string, string> = {}, runKey = TICKET): Promise<void> {
    key = runKey;
    flow = await createFlowHarness(key, {
      realHost: true,
      realSteps: ['branch', 'commit'],
      ...(Object.keys(repoFiles).length > 0 ? { repoFiles } : {}),
    });
    await flow.begin('plan');
  }

  const documents = () => flow.app.app.get(DocumentRepository);
  const stored = async (kind: string) => (await documents().latestBody(key, kind)) ?? '';

  async function put(kind: string, body: string): Promise<void> {
    const run = (await flow.app.app.get(RunRepository).findRun(key))!;
    await documents().putDocument(run, kind, body);
  }

  /** The branch step stores the name; one file is then committed by the commit step. Returns the message. */
  async function commitOne(): Promise<string> {
    await flow.app.pipeline.step('branch', key);
    mkdirSync(join(flow.tree, 'src'), { recursive: true });
    writeFileSync(join(flow.tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await flow.app.pipeline.step('commit', key);
    return git(flow.tree, ['log', '-1', '--format=%s']);
  }

  const plan = (change: object) => JSON.stringify({ summary: ['s'], plan: ['one'], change });

  it("gives today's names when nothing is configured", async () => {
    await start();
    expect(await commitOne()).toBe(`feat(${TICKET}): Ship the field`);
    expect(await stored('branch_names')).toBe(`demo ${TODAY}\n`);
  });

  it('gives Conventional Commits when the repository has a commitlint config', async () => {
    await start(CONVENTIONAL);
    await put('plan_result', plan({ type: 'fix', scope: 'api', subject: 'Stop the loop' }));
    expect(await commitOne()).toBe('fix(api): Stop the loop');
  });

  it('leaves out the scope of a change that has none', async () => {
    await start(CONVENTIONAL);
    await put('plan_result', plan({ type: 'feat', subject: 'Add the field' }));
    expect(await commitOne()).toBe('feat: Add the field');
  });

  it('renders the ticket of the manifest template, and drops it with no ticket', async () => {
    const files = { '.swarmloop.json': JSON.stringify({ version: 1, git: { commit: '[{ticket} ]{subject}' } }) };
    await start(files);
    expect(await commitOne()).toBe(`${TICKET} Ship the field`);
    await flow.close();
    await start(files, 'vendor-api');
    expect(await commitOne()).toBe('Ship the field');
  });

  it('keeps the branch when the summary changes in the middle of the run', async () => {
    await start();
    await flow.app.pipeline.step('branch', key);
    const requirements = JSON.parse(await stored('requirements')) as { tickets: { summary: string }[] };
    requirements.tickets[0].summary = 'Ship another field';
    await put('requirements', `${JSON.stringify(requirements)}\n`);
    await flow.app.pipeline.step('branch', key);
    expect(await stored('branch_names')).toBe(`demo ${TODAY}\n`);
    expect(git(flow.tree, ['branch', '--show-current'])).toBe(TODAY);
  });

  it('gives each repository of a run that does not split its own branch and commit from its own format', async () => {
    await start();
    // `shop` is on a branch of its own work and has a manifest of its own; `demo` has no format.
    const { tree: shop } = featureWorktree(flow.app.root, key, 'shop');
    git(shop, ['switch', '-c', 'wip']);
    const manifest = { version: 1, git: { branch: 'work/{slug}', commit: '{type}: {subject}' } };
    writeFileSync(join(shop, '.swarmloop.json'), JSON.stringify(manifest));
    git(shop, ['add', '.swarmloop.json']);
    git(shop, ['commit', '-m', 'chore: add the manifest']);
    await put('repos', 'demo\nshop\n');
    await flow.app.pipeline.step('branch', key);
    expect(await stored('branch_names')).toBe(`demo ${TODAY}\nshop work/ship-the-field\n`);
    for (const tree of [flow.tree, shop]) {
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    }
    await flow.app.pipeline.step('commit', key);
    expect(git(flow.tree, ['log', '-1', '--format=%s'])).toBe(`feat(${TICKET}): Ship the field`);
    expect(git(shop, ['log', '-1', '--format=%s'])).toBe('feat: Ship the field');
    expect(git(shop, ['branch', '--show-current'])).toBe('work/ship-the-field');
    expect(git(shop, ['rev-parse', 'HEAD'])).toBe(git(shop, ['rev-parse', 'refs/remotes/origin/work/ship-the-field']));
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(git(flow.tree, ['rev-parse', `refs/remotes/origin/${TODAY}`]));
  });
});
