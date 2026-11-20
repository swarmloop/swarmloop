import 'reflect-metadata';
import { existsSync } from 'fs';
import { join } from 'path';
import { mountsForStep } from '../git/repo-names';
import { GitRulesWriter } from '../steps/shared/git-rules-writer';
import { DocumentRepository } from '../history/document.repository';
import { createFlowHarness } from './flow-harness';

const KEY = 'PROJ-640';
const SOURCE = `feature/${KEY}-ship-the-field`;
const RULES = { commit: '{type}: {subject}' };

/** A repository with only a devcontainer gets no .swarmloop.json: the merge request text says which lines to add. */
describe('a learned git rule in a repository with only a devcontainer', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('creates no file and ends the merge request text with the lines to add', async () => {
    flow = await createFlowHarness(KEY, {
      realHost: true,
      repoFiles: { '.devcontainer/devcontainer.json': '{"image":"node:22"}\n' },
    });
    const run = await flow.begin('merge-request');
    // The image of a devcontainer cannot be pulled by the fake sandbox, so the implement step is not run: the rules it
    // learned go through the same writer it uses, and its note is stored for the merge request step as implement stores it.
    const mounts = mountsForStep(flow.app.root, KEY, ['demo'], null);
    const note = await flow.app.app.get(GitRulesWriter).write(mounts, RULES);
    const documents = flow.app.app.get(DocumentRepository);
    const notes = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
    const parts = { line: 'The field ships.', done: ['x'], worthALook: [], notes, risk: 'low', riskReason: 'small' };
    await documents.putDocument(run, 'review_report_result', JSON.stringify(parts));
    await documents.putDocument(run, 'git_rules_note', note);
    await flow.app.pipeline.step('merge-request', KEY);

    expect(existsSync(join(flow.tree, '.swarmloop.json'))).toBe(false);
    const body = (await flow.host.findMergeRequest({ project: '', source: SOURCE })).record?.summary ?? '';
    expect(body).toContain('The field ships.');
    expect(
      body.endsWith(
        `Add to the "git" section of .swarmloop.json of demo:\n    "commit": "{type}: {subject}"\n`.trimEnd(),
      ),
    ).toBe(true);
  });
});
