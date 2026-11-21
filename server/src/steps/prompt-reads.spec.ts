import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { markedTail } from '../core/run-logs';
import { reviewContinue, reviewResume } from './code-review/code-review.prompts';
import { REVIEW_DIFF_PATH, REVIEW_DIFF_READ } from './code-review/review-diff';
import { withAttachments } from './shared/attachments-section';
import { alsoReadLine, skillFileReads, withLogReads, withOutsideReads } from './shared/outside-reads';
import { unallowedReads } from './shared/outside-reads.spec-helpers';
import { skillPrompt, workingDirectoryBlock } from './shared/skill-prompt';

const GOLDEN = join(__dirname, '../testing/golden');
const BASE = '/work/brief/skills/implement/project-base.md';
const MOUNTS = [{ hostPath: '/tmp/prompt-reads-missing', containerPath: '/work/api' }];
const STEPS = ['research', 'plan', 'plan-improve', 'implement', 'implement-improve', 'code-review'];
const NAMED = /^(code-review\.|implement.*\.json|plan\.[\w-]*written|plan-improve\.|research\.)/;

interface Exchange {
  chatId: string;
  requestText: string;
}

/** Every recorded request of the agent steps, with the first request of its chat. */
function requests(): { file: string; text: string; earlier?: string }[] {
  const found: { file: string; text: string; earlier?: string }[] = [];
  for (const file of readdirSync(GOLDEN).filter((name) => NAMED.test(name))) {
    const trace = JSON.parse(readFileSync(join(GOLDEN, file), 'utf8')) as { visits?: { exchanges: Exchange[] }[] };
    const first = new Map<string, string>();
    for (const exchange of (trace.visits ?? []).flatMap((visit) => visit.exchanges)) {
      found.push({
        file,
        text: exchange.requestText,
        earlier: first.get(exchange.chatId),
      });
      first.set(exchange.chatId, first.get(exchange.chatId) ?? exchange.requestText);
    }
  }
  return found;
}

describe('every path a prompt asks an agent to read is allowed by its block', () => {
  it('holds for each recorded agent request of every agent step', () => {
    const all = requests();
    for (const step of STEPS) {
      expect(
        all.filter((item) => item.file.startsWith(`${step}.`) || item.file.startsWith(`${step}-`)).length,
      ).toBeGreaterThan(0);
    }
    for (const item of all) {
      expect({ file: item.file, paths: unallowedReads(item.text, item.earlier) }).toEqual({
        file: item.file,
        paths: [],
      });
    }
  });

  it.each(['research', 'plan-improve', 'implement-improve', 'code-review/report'])(
    'adds no Also read line to the %s prompt',
    (skill) => {
      expect(skillPrompt(skill, '{}', ['api'], [], MOUNTS)).not.toContain('Also read');
    },
  );

  it.each(['plan', 'implement', 'code-review/requirements'])('allows the project base in the %s prompt', (skill) => {
    const prompt = skillPrompt(skill, '{}', ['api'], [], MOUNTS);
    expect(prompt).toContain(BASE);
    expect(unallowedReads(prompt)).toEqual([]);
  });

  it('allows the diff in a reviewer prompt, and in its resumed and continued prompts', () => {
    const sections = [{ heading: 'Diff', body: `The complete diff is ${REVIEW_DIFF_PATH}. Read that file.` }];
    const first = skillPrompt('code-review/requirements', '{}', ['api'], sections, MOUNTS, {
      reads: [REVIEW_DIFF_READ],
    });
    expect(first).toContain(
      `Also read, and nothing else outside: ${REVIEW_DIFF_PATH} (the complete diff), ${BASE} (a skill file).`,
    );
    expect(unallowedReads(first)).toEqual([]);
    expect(unallowedReads(reviewResume('requirements', 'done', 'checked'), first)).toEqual([]);
    expect(unallowedReads(reviewContinue('requirements'), first)).toEqual([]);
    expect(unallowedReads(reviewContinue('requirements'))).toEqual([REVIEW_DIFF_PATH]);
  });

  it('allows the attachments folder and the log folder where a prompt names them', () => {
    const log = markedTail(['a', 'b', 'c'], 30, 2, 100, '/data/run-logs/k/checks-log.txt');
    const first = `${skillPrompt('implement', '{}', ['api'], [{ heading: 'Checks', body: log }], MOUNTS)}`;
    const sent = withLogReads(withAttachments(first, ['spec.pdf']));
    expect(sent).toContain('/work/brief/attachments/spec.pdf');
    expect(unallowedReads(first)).toEqual(['/work/logs/checks-log.txt']);
    expect(unallowedReads(sent)).toEqual([]);
    const resumed = reviewResume('requirements', 'done', 'checked');
    expect(unallowedReads(withAttachments(resumed, ['spec.pdf']))).toEqual([]);
    expect(unallowedReads(withLogReads(withAttachments(resumed, ['spec.pdf'])), first)).toEqual([]);
    const followUp = `Check failed.\n${log}`;
    expect(unallowedReads(withLogReads(withAttachments(followUp, ['spec.pdf'])), sent)).toEqual([]);
    const line = withLogReads(withAttachments(followUp, ['spec.pdf'])).split('\n')[0];
    expect(line).toBe(
      'Also read, and nothing else outside: /work/brief/attachments/ (the files attached to the task), /work/logs/ (the full logs of cut check and pipeline output).',
    );
  });
});

describe('outside reads', () => {
  const block = workingDirectoryBlock(['api'], MOUNTS);

  it('leaves a prompt with no reads, and a run with no files or no cut log, as it is', () => {
    expect(withOutsideReads(block, [])).toBe(block);
    expect(withAttachments(block, [])).toBe(block);
    expect(withLogReads(block)).toBe(block);
    expect(alsoReadLine([])).toBe('');
  });

  it('puts the line before the stay line and merges later reads without a duplicate', () => {
    const once = withOutsideReads(block, [{ path: '/work/brief/a.md', what: 'a note' }]);
    const lines = once.split('\n');
    expect(lines[1]).toBe('Also read, and nothing else outside: /work/brief/a.md (a note).');
    expect(lines[2]).toMatch(/^Do not look outside it\./);
    const twice = withOutsideReads(once, [
      { path: '/work/brief/a.md', what: 'a note' },
      { path: '/work/brief/b.md', what: 'another' },
    ]);
    expect(twice.split('\n')[1]).toBe(
      'Also read, and nothing else outside: /work/brief/a.md (a note), /work/brief/b.md (another).',
    );
  });

  it('names each skill file once, without trailing punctuation', () => {
    expect(
      skillFileReads('Read /work/brief/skills/x/y.md. Then /work/brief/skills/x/y.md, and /work/brief/skills/z.md'),
    ).toEqual([
      { path: '/work/brief/skills/x/y.md', what: 'a skill file' },
      { path: '/work/brief/skills/z.md', what: 'a skill file' },
    ]);
  });
});
