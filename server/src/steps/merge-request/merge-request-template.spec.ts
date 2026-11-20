import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunEntity } from '../../history/entities';
import type { ChatAnswer, ImplementChat } from '../shared/implement-chat';
import { REPORT_END, REPORT_START, foldedReport, reportOf } from '../shared/report-markers';
import { MergeRequestTemplate, noteLines } from './merge-request-template';
import type { Tree } from './merge-request-trees';

const RUN = { key: 'PROJ-1', codeHost: 'gitlab' } as RunEntity;
const REPORT = 'The report.';
const built = { text: REPORT, report: true };

describe('merge request template', () => {
  let dir: string;
  const prompts: string[] = [];
  let answer: ChatAnswer;
  const chat = {
    ask: async (_run: RunEntity, _repos: string[], prompt: string) => {
      prompts.push(prompt);
      return answer;
    },
  } as unknown as ImplementChat;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmloop-mr-template-'));
    prompts.length = 0;
    answer = { value: { text: '- [x] tested\n- [ ] documented' } };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function tree(existing: string | null = null, repo = 'demo'): Tree {
    return {
      repo,
      path: dir,
      project: 'group/demo',
      branch: 'feature/x',
      target: 'main',
      existing: existing === null ? null : { project: 'group/demo', iid: 3, url: 'u', summary: existing, draft: true },
      summary: '',
    };
  }

  function template(text: string): void {
    mkdirSync(join(dir, '.gitlab/merge_request_templates'), { recursive: true });
    writeFileSync(join(dir, '.gitlab/merge_request_templates/Default.md'), text);
  }

  it('gives the report between the markers when the repository has no template', async () => {
    const { trees } = await new MergeRequestTemplate(chat).bodies(RUN, [tree()], built, null);
    expect(trees[0]?.summary).toBe(`${REPORT_START}\n${REPORT}\n${REPORT_END}`);
    expect(prompts).toEqual([]);
  });

  it('gives the filled template and then the folded report', async () => {
    template('- [ ] tested\n- [ ] documented');
    const { trees, errors } = await new MergeRequestTemplate(chat).bodies(RUN, [tree()], built, null);
    expect(trees[0]?.summary).toBe(`- [x] tested\n- [ ] documented\n\n${foldedReport(REPORT)}`);
    expect(prompts[0]).toContain('- [ ] tested');
    expect(prompts[0]).toContain(REPORT);
    expect(errors).toEqual([]);
  });

  it('falls back to the report body and names the reason when the agent fails or answers badly', async () => {
    template('- [ ] tested');
    answer = { error: 'implement failed: usage' };
    const failed = await new MergeRequestTemplate(chat).bodies(RUN, [tree()], built, null);
    expect(failed.trees[0]?.summary).toBe(`${REPORT_START}\n${REPORT}\n${REPORT_END}`);
    expect(failed.errors).toEqual(['demo: template not filled: implement failed: usage']);
    answer = { value: { text: '  ' } };
    const empty = await new MergeRequestTemplate(chat).bodies(RUN, [tree()], built, null);
    expect(empty.trees[0]?.summary).toBe(`${REPORT_START}\n${REPORT}\n${REPORT_END}`);
    expect(empty.errors).toEqual(['demo: template not filled: the answer had no text']);
  });

  it('does not read a template that links out of the worktree', async () => {
    const outside = join(dir, '..', `${dir.split('/').pop()}-secret.md`);
    writeFileSync(outside, 'server secret');
    try {
      mkdirSync(join(dir, '.gitlab/merge_request_templates'), { recursive: true });
      symlinkSync(outside, join(dir, '.gitlab/merge_request_templates/Default.md'));
      const { trees } = await new MergeRequestTemplate(chat).bodies(RUN, [tree()], built, null);
      expect(prompts).toEqual([]);
      expect(trees[0]?.summary).toBe(`${REPORT_START}\n${REPORT}\n${REPORT_END}`);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('updates only the marked report of an existing body and does not ask again', async () => {
    template('- [ ] tested');
    const existing = `- [x] tested\n\n${foldedReport('old')}\n\nlast`;
    const { trees } = await new MergeRequestTemplate(chat).bodies(RUN, [tree(existing)], built, null);
    expect(trees[0]?.summary).toBe(`- [x] tested\n\n${foldedReport(REPORT)}\n\nlast`);
    expect(prompts).toEqual([]);
  });

  it('asks again for an existing body that has no markers', async () => {
    template('- [ ] tested');
    const { trees } = await new MergeRequestTemplate(chat).bodies(RUN, [tree('old text')], built, null);
    expect(reportOf(trees[0]?.summary ?? '')).toBe(REPORT);
    expect(prompts).toHaveLength(1);
  });

  it('ends the body with the note of its own repository only', async () => {
    template('- [ ] tested');
    const head = 'Add to the "git" section of .swarmloop.json of';
    const note = `${head} demo:\n    "branch": "{key}-{slug}"\n\n${head} other:\n    "commit": "x"`;
    const { trees } = await new MergeRequestTemplate(chat).bodies(RUN, [tree(), tree(null, 'other')], built, note);
    expect(trees[0]?.summary.endsWith(`</details>\n\n${head} demo:\n    "branch": "{key}-{slug}"`)).toBe(true);
    expect(trees[1]?.summary.endsWith(`</details>\n\n${head} other:\n    "commit": "x"`)).toBe(true);
    const again = await new MergeRequestTemplate(chat).bodies(RUN, [tree(trees[0]?.summary)], built, note);
    expect(again.trees[0]?.summary).toBe(trees[0]?.summary);
  });

  it('reads no lines from a note of another repository', () => {
    expect(noteLines('Add to the "git" section of .swarmloop.json of other:\n    "commit": "x"', 'demo')).toBe('');
    expect(noteLines(null, 'demo')).toBe('');
  });

  it('reads the block the rules writer wrote for the repository, or for the only repository', () => {
    const own = 'Add to the "git" section of .swarmloop.json of demo:\n    "commit": "{type}: {subject}"';
    const other = 'Add to the "git" section of .swarmloop.json of web:\n    "title": "{subject}"';
    expect(noteLines(`${other}\n\n${own}`, 'demo')).toBe(own);
    const alone = 'Add to the "git" section of .swarmloop.json:\n    "commit": "{type}: {subject}"';
    expect(noteLines(alone, 'demo')).toBe(alone);
  });
});
