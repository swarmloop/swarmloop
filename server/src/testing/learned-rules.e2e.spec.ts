import 'reflect-metadata';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readGitFormat } from '../git/naming/git-format';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { git } from './git-fixture';
import { approvedRun } from './implement-flow.spec-helpers';
import { BlockAgentRunner } from './result-answer';

const KEY = 'PROJ-612';
const RULES = { commit: '{type}: {subject}' };
const FILE = '.swarmloop.json';

/** A rule implement learned goes into the repository with the work, before checks, and the next run follows it. */
describe('a learned git rule is written with the work', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  async function implementWithRules(repoFiles?: Record<string, string>): Promise<void> {
    const answer = { implementation: ['changed the field'], summary: ['done'], gitRules: RULES };
    const blocks = new BlockAgentRunner({ implement: [{ block: answer }] });
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      realSteps: ['branch', 'commit'],
      ...(repoFiles ? { repoFiles } : {}),
    });
    await approvedRun(flow, KEY, 'implement');
    await flow.app.pipeline.step('branch', KEY);
    await flow.app.pipeline.step('implement', KEY);
  }

  const written = (): unknown => JSON.parse(readFileSync(join(flow.tree, FILE), 'utf8'));

  async function commitIsPushedWithTheRule(): Promise<void> {
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('implement-improve');
    await flow.app.pipeline.step('commit', KEY);
    expect(git(flow.tree, ['show', '--name-only', '--format=%s', 'HEAD'])).toContain(FILE);
    expect(git(flow.tree, ['log', '-1', '--format=%s'])).toBe('feat: Ship the field');
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(git(flow.tree, ['rev-parse', '@{u}']));
    expect(readGitFormat(flow.tree).commit).toBe(RULES.commit);
  }

  it('adds the rule to the .swarmloop.json of the repository before checks and commits it', async () => {
    await implementWithRules({ [FILE]: JSON.stringify({ version: 1, git: { target: 'main' } }) });
    expect(written()).toEqual({ version: 1, git: { target: 'main', ...RULES } });
    await commitIsPushedWithTheRule();
  });

  it('creates a .swarmloop.json when the repository has no environment file', async () => {
    await implementWithRules();
    expect(existsSync(join(flow.tree, FILE))).toBe(true);
    expect(written()).toEqual({ version: 1, git: RULES });
    await commitIsPushedWithTheRule();
  });

  it('takes the rule of implement-improve the same way', async () => {
    const blocks = new BlockAgentRunner({
      'implement-improve': [{ block: { summary: ['checked'], gitRules: RULES } }],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    const run = await approvedRun(flow, KEY, 'implement-improve');
    await flow.app.app.get(DocumentRepository).putDocument(run, 'implementation', '- changed the field\n');
    await flow.app.app
      .get(DocumentRepository)
      .putDocument(
        run,
        'implementation_result',
        JSON.stringify({ implementation: ['changed the field'], summary: ['done'] }),
      );
    await flow.app.pipeline.step('implement-improve', KEY);
    expect(written()).toEqual({ version: 1, git: RULES });
  });
});
