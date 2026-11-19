import 'reflect-metadata';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { REPORT_END, REPORT_START, reportOf } from '../steps/shared/report-markers';
import { result } from '../steps/plan/plan.step.spec-helpers';
import type { AgentRunInput } from '../agent/agent-runner';
import { createFlowHarness } from './flow-harness';
import { resultAnswer } from './result-answer';
import type { FakeAgentRunner } from './test-app';

const KEY = 'PROJ-620';
const SOURCE = `feature/${KEY}-ship-the-field`;
const TEMPLATE_PATH = '.gitlab/merge_request_templates/Default.md';
const TEMPLATE = '## What changed\n\n- [ ] tests added\n- [ ] docs updated\n';
const FILLED = '## What changed\n\nThe field ships.\n\n- [x] tests added\n- [ ] docs updated';

/** The agent that fills the template: it is asked in a chat of its own, because the run has no implement chat. */
class TemplateAgent implements FakeAgentRunner {
  readonly steps: string[] = [];
  readonly prompts: string[] = [];

  run(step: string, input: AgentRunInput): Promise<unknown> {
    this.steps.push(step);
    if (step !== 'merge-request') return Promise.resolve(undefined);
    this.prompts.push(input.prompt);
    return Promise.resolve(result(resultAnswer('Filled.', { text: FILLED })));
  }
}

describe('the merge request reads like the repository own', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let agent: TemplateAgent;
  let targets: string[];

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  async function openRequest(
    repoFiles: Record<string, string>,
    options: { note?: string; prompt?: string } = {},
  ): Promise<string> {
    agent = new TemplateAgent();
    flow = await createFlowHarness(KEY, {
      realHost: true,
      ...(Object.keys(repoFiles).length > 0 ? { repoFiles } : {}),
      runner: agent,
    });
    targets = [];
    const open = flow.host.openMergeRequest.bind(flow.host);
    jest.spyOn(flow.host, 'openMergeRequest').mockImplementation((draft) => {
      targets.push(draft.target);
      return open(draft);
    });
    const run = await flow.begin('merge-request');
    const documents = flow.app.app.get(DocumentRepository);
    const notes = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
    const parts = { line: 'The field ships.', done: ['x'], worthALook: [], notes, risk: 'low', riskReason: 'small' };
    await documents.putDocument(run, 'review_report_result', JSON.stringify(parts));
    if (options.note) await documents.putDocument(run, 'git_rules_note', options.note);
    if (options.prompt) {
      const runs = flow.app.app.get(RunRepository);
      await runs.saveRun({ ...(await runs.findRun(KEY))!, prompt: options.prompt });
    }
    await flow.app.pipeline.step('merge-request', KEY);
    return (await flow.host.findMergeRequest({ project: '', source: SOURCE })).record?.summary ?? '';
  }

  it('gives the filled template and then one folded report between the markers', async () => {
    const body = await openRequest({ [TEMPLATE_PATH]: TEMPLATE });
    expect(body.startsWith(`${FILLED}\n\n<details><summary>`)).toBe(true);
    expect(body.endsWith('</details>')).toBe(true);
    expect(body.split('<details><summary>Run report</summary>')).toHaveLength(2);
    expect(body).toContain(REPORT_START);
    expect(body).toContain(REPORT_END);
    expect(reportOf(body)).toContain('The field ships.');
    expect(agent.prompts[0]).toContain('- [ ] tests added');
  });

  it('ends the body with the lines of the stored git rules note', async () => {
    const body = await openRequest({ [TEMPLATE_PATH]: TEMPLATE }, { note: 'demo:\n"commit": "{type}: {subject}"' });
    expect(body.endsWith('</details>\n\n"commit": "{type}: {subject}"')).toBe(true);
  });

  it('gives the report as before when the repository has no template', async () => {
    const body = await openRequest({});
    expect(body.startsWith(REPORT_START)).toBe(true);
    expect(body.endsWith(REPORT_END)).toBe(true);
    expect(body).not.toContain('<summary>Run report</summary>');
    expect(agent.prompts).toEqual([]);
  });

  it('aims at the target of the manifest', async () => {
    const manifest = JSON.stringify({ version: 1, git: { target: 'release' } });
    await openRequest({ '.swarmloop.json': manifest });
    expect(targets).toEqual(['release']);
  });

  it('aims at the base the prompt names before the target of the manifest', async () => {
    const manifest = JSON.stringify({ version: 1, git: { target: 'release' } });
    await openRequest({ '.swarmloop.json': manifest }, { prompt: 'Ship the field\nbranch: feature/PARENT-1-epic\n' });
    expect(targets).toEqual(['feature/PARENT-1-epic']);
  });
});
