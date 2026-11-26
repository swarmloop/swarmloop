import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subtask } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { branchName, summaryForBranch } from '../../git/naming/git-names';
import { renderMergeRequest } from '../../steps/merge-request/merge-request-record';
import type { createFlowHarness } from '../flow-harness';
import { git, save } from '../runs.spec-helpers';
import { storeRun } from '../store-run.spec-helpers';

type Flow = Awaited<ReturnType<typeof createFlowHarness>>;

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

/** A split parent on a real clone and a fake host, whose parts are delivered by hand and merge into the epic branch. The flow is made with `realHost` and `taskWorktrees`. */
export function epicMerges(flow: () => Flow, key: string) {
  const feature = `feature/${key}-ship-the-field`;
  const requirements = `${JSON.stringify({
    prompt: 'Ship the field\n',
    tickets: [{ key, summary: 'Ship the field' }],
    plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
  })}\n`;
  const runs = () => flow().app.app.get(RunRepository);
  const documents = () => flow().app.app.get(DocumentRepository);
  const clone = () => join(flow().app.root, 'demo');

  /** The parent has started its parts. */
  async function seed(ids: string[]): Promise<void> {
    const parent = await save(runs(), key, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    parent.codeHost = 'gitlab';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(ids.map(task))}\n`);
    await flow().app.pipeline.step('implement', key);
  }

  /** The part's branch is cut from the epic branch, gets a commit, is pushed with a passing CI and a merge request, and its run ends done. */
  async function deliver(id: string): Promise<{ iid: number }> {
    const run = (await runs().findRun(`${key}-${id}`))!;
    const branch = branchName(run.key, summaryForBranch(requirements, run.key));
    const tree = join(flow().app.root, 'worktrees', run.key, 'demo');
    git(clone(), ['fetch', 'origin']);
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone(), ['worktree', 'add', '-b', branch, tree, `origin/${feature}`]);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, `src/${id}.ts`), `export const ${id} = 1;\n`);
    git(tree, ['add', `src/${id}.ts`]);
    git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', `feat: ${id}`]);
    git(tree, ['push', 'origin', branch]);
    flow().host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
    const { record } = await flow().host.openMergeRequest({
      project: 'demo',
      source: branch,
      target: feature,
      title: id,
      summary: '',
      draft: false,
    });
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    await documents().putDocument(run, 'implementation', '- shipped the task\n');
    run.prompt = `branch: ${feature}\n`;
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await storeRun(runs(), run);
    return { iid: record.iid };
  }

  return { seed, deliver };
}
