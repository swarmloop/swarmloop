import type { Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { ARTIFACTS, reviewResultOf } from '../steps/contract/artifacts';
import type { ReviewResult } from '../agent-result/definitions/review';
import type { createFlowHarness } from './flow-harness';
import { save } from './runs.spec-helpers';

const HOUR = 3_600_000;

const task = (id: string, covers: string[]): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  covers,
  status: 'waiting',
});

/** A final requirements review that returns the change with R3 missing. */
export const missing = (note: string): ReviewResult => ({
  decision: 'return',
  review: 'Checked.',
  summary: [],
  requirements: [
    { id: 'R1', status: 'met', note: 'done' },
    { id: 'R2', status: 'met', note: 'done' },
    { id: 'R3', status: 'missing', note },
  ],
});

/** The steps of an epic of three tasks whose final review marks a gap, run by hand on a flow harness. */
export function gapEpic(flow: () => Awaited<ReturnType<typeof createFlowHarness>>, key: string) {
  const requirements = `${JSON.stringify({
    prompt: 'Ship the field\n',
    tickets: [{ key, summary: 'Ship the field' }],
    plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
  })}\n`;
  const runs = () => flow().app.app.get(RunRepository);
  const documents = () => flow().app.app.get(DocumentRepository);

  /** One pass of the parent's implement step. */
  const pass = async () => {
    await flow().app.pipeline.step('implement', key);
    await flow().app.app.get(CommandService).idle();
  };

  /** A task's run ends merged. */
  async function merged(id: string, iid: number): Promise<void> {
    const run = (await runs().findRun(`${key}-${id}`))!;
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    // The task settles after the review stored while it still runs: the fake clock stands still, so the time is set ahead.
    writeRunState(run, {
      status: 'done',
      currentStep: 'done',
      doneAt: new Date(flow().app.clock.now() + HOUR).toISOString(),
    });
    await runs().saveRun(run);
  }

  /** A three-task epic whose tasks merged; the parent went on to its checks. */
  async function epic() {
    const parent = await save(runs(), key, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    const list = ['R1', 'R2', 'R3'].map((id) => ({ id, text: `Requirement ${id}` }));
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'requirement_list', `${JSON.stringify(list)}\n`);
    await documents().putDocument(parent, 'contract', '- api (owner a): the api\n');
    const planned = [task('a', ['R1']), task('b', ['R2']), task('c', ['R3'])];
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(planned)}\n`);
    await pass();
    for (const [index, id] of ['a', 'b', 'c'].entries()) await merged(id, index + 1);
    await pass();
    await pass();
    expect((await runs().findRun(key))?.currentStep).toBe('checks');
    return parent;
  }

  /** Stores what code review stores for a returning final review: its result and the return notes it writes. */
  const review = async (parent: Awaited<ReturnType<typeof epic>>, value: ReviewResult) => {
    await documents().putDocument(
      parent,
      reviewResultOf('requirements').kind,
      reviewResultOf('requirements').format(value),
    );
    await documents().putDocument(parent, ARTIFACTS.return.kind, 'requirements returned the change\n');
  };

  return { pass, merged, epic, review };
}
