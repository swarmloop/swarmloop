import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer } from '../../testing/result-answer';
import { ARTIFACTS } from '../contract/artifacts';
import { answerFor, boot, result, seed, writeEnv } from './code-review.step.spec-helpers';

const LIST = [
  { id: 'R1', text: 'Parse the field' },
  { id: 'R2', text: 'Keep the segment' },
  { id: 'R3', text: 'Reject an empty field' },
  { id: 'R4', text: 'Log the rejection' },
];
const ITEMS = ['parse the field in the parser', 'reject empty input'];
const COVERAGE = [
  { ...LIST[0], items: [ITEMS[0]] },
  { ...LIST[1], items: [ITEMS[0]] },
  { ...LIST[2], items: [ITEMS[1]] },
  { ...LIST[3], items: [] },
];

const KINDS = ['issues', 'review_requirements', 'review_requirements_result', 'review_report'];

type Status = 'met' | 'partial' | 'missing';

/** The requirements reviewer's answer: every id met, except the ones named. */
function marked(unmet: Partial<Record<string, Status>> = {}, decision?: 'ok' | 'return', skip: string[] = []): string {
  const requirements = LIST.filter((item) => !skip.includes(item.id)).map((item) => ({
    id: item.id,
    status: unmet[item.id] ?? 'met',
    note: `note for ${item.id}`,
  }));
  const open = requirements.some((mark) => mark.status !== 'met');
  return resultAnswer('Checked.', {
    decision: decision ?? (open ? 'return' : 'ok'),
    review: 'Checked.',
    summary: [],
    requirements,
  });
}

interface Options {
  withList?: boolean;
  resumed?: boolean;
}

async function round(key: string, requirementsAnswers: string[], options: Options = {}) {
  const { withList = true, resumed = false } = options;
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-requirements-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  if (resumed) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', `${key}-code-review-quality-session.json`),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'quality-chat', resumed: true, completed: true, killReason: null, usd: 3, resultName: 'review_quality' })}\n`,
    );
  }
  const queue = [...requirementsAnswers];
  const agent = jest.fn(async (input: AgentRunInput) =>
    result(
      input.step.endsWith('requirements') && queue.length > 0 ? queue.shift()! : answerFor(input.step),
      input.step,
    ),
  );
  const app = await boot(root, agent);
  try {
    await seed(app, key);
    const documents = app.get(DocumentRepository);
    const owner = await documentRun(app, key);
    await documents.putDocument(
      owner,
      'requirements',
      `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Plan', overview: '', items: ITEMS, decision: 'approve' } })}\n`,
    );
    if (withList) {
      await documents.putDocument(owner, ARTIFACTS.requirementList.kind, ARTIFACTS.requirementList.format(LIST));
      await documents.putDocument(
        owner,
        ARTIFACTS.requirementCoverage.kind,
        ARTIFACTS.requirementCoverage.format(COVERAGE),
      );
    }
    const done = await app.get(PipelineService).step('code-review', key);
    const stored = new Map<string, string | null>();
    for (const kind of KINDS) {
      stored.set(kind, await documents.latestBody(key, kind));
    }
    return {
      done,
      calls: agent.mock.calls.map((call) => call[0]),
      body: (kind: string) => stored.get(kind) ?? null,
    };
  } finally {
    await app.close();
  }
}

async function documentRun(app: Awaited<ReturnType<typeof boot>>, key: string) {
  const { RunRepository } = await import('../../history/run.repository');
  const found = await app.get(RunRepository).findRun(key);
  if (!found) {
    throw new Error('the run is missing');
  }
  return found;
}

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('code review with the requirements list', () => {
  it('gives every reviewer the list and the plan with covers in its first prompt, once', async () => {
    const { calls } = await round('PROJ-501', [marked()]);
    const reviewers = calls.filter((call) => call.step !== 'code-review-report');
    expect(reviewers).toHaveLength(5);
    for (const call of reviewers) {
      expect(occurrences(call.prompt, 'Requirements list:\nR1: Parse the field')).toBe(1);
      expect(call.prompt).toContain('R3: Reject an empty field');
      expect(call.prompt).toContain(`- ${ITEMS[0]} - covers: R1, R2`);
      expect(call.prompt).toContain(`- ${ITEMS[1]} - covers: R3`);
      expect(occurrences(call.prompt, 'covers: R3')).toBe(1);
    }
    const requirements = reviewers.find((call) => call.step === 'code-review-requirements')!;
    expect(requirements.prompt).toContain('by its id');
  });

  it('gives the report the list once, and shows how many requirements the review marked met', async () => {
    const { calls, body } = await round('PROJ-509', [marked({ R3: 'partial', R4: 'missing' })]);
    const report = calls.find((call) => call.step === 'code-review-report')!;
    expect(occurrences(report.prompt, 'Requirements list:\nR1: Parse the field')).toBe(1);
    expect(report.prompt).toContain('R4: Log the rejection');
    expect(body('review_report')).toContain('| 2/4 met |');
  });

  it('gives a resumed reviewer neither the list nor covers', async () => {
    const { calls } = await round('PROJ-502', [marked()], { resumed: true });
    const quality = calls.find((call) => call.step === 'code-review-quality')!;
    expect(quality.prompt).toContain('Continue this quality review');
    expect(quality.prompt).not.toContain('\nRequirements list:\n');
    expect(quality.prompt).not.toContain('covers:');
    expect(quality.prompt).toContain('name one broken behavior');
  });

  it('returns for one missing requirement and names it in the return and the issue', async () => {
    const { done, body } = await round('PROJ-503', [marked({ R3: 'missing' })]);
    expect(done.exitCode).toBe(0);
    const issues = body('issues') ?? '';
    expect(issues).toContain('R3 missing: note for R3');
    expect(body('review_requirements')).toContain('R3 missing: note for R3');
  });

  it('gives one return that names every unmet requirement, and the document marks every id', async () => {
    const { calls, body } = await round('PROJ-504', [marked({ R2: 'missing', R4: 'partial' })]);
    expect(calls.filter((call) => call.step === 'code-review-requirements')).toHaveLength(1);
    const review = body('review_requirements') ?? '';
    expect(review).toContain('R2 missing: note for R2');
    expect(review).toContain('R4 partial: note for R4');
    expect(review.indexOf('R1 met')).toBeLessThan(review.indexOf('R2 missing'));
    expect(review.indexOf('R4 partial')).toBeLessThan(review.indexOf('decision: return'));
    expect(body('issues')).toContain('R4 partial: note for R4');
    const brief = calls.find((call) => call.step === 'code-review-report')!.prompt;
    expect(brief).toContain('R1 met: note for R1');
    expect(brief).toContain('R2 missing: note for R2');
  });

  it('stores one requirements entry per id in the result', async () => {
    const { body } = await round('PROJ-505', [marked()]);
    const stored = JSON.parse(body('review_requirements_result') ?? '{}');
    expect(stored.requirements.map((mark: { id: string }) => mark.id)).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('sends the result follow-up for an answer with no entry for an id', async () => {
    const { calls, body } = await round('PROJ-506', [marked({}, undefined, ['R3']), marked()]);
    const asked = calls.filter((call) => call.step === 'code-review-requirements');
    expect(asked).toHaveLength(2);
    expect(asked[1].prompt).toContain('R3 has no entry in requirements');
    expect(body('review_requirements')).toContain('R3 met: note for R3');
  });

  it('sends the result follow-up for ok with a partial entry', async () => {
    const { calls } = await round('PROJ-507', [marked({ R1: 'partial' }, 'ok'), marked()]);
    const asked = calls.filter((call) => call.step === 'code-review-requirements');
    expect(asked).toHaveLength(2);
    expect(asked[1].prompt).toContain('R1 is not met');
  });
});

describe('code review without a requirements list', () => {
  it('builds prompts and the review document as before', async () => {
    const { calls, body } = await round('PROJ-508', [], { withList: false });
    for (const call of calls) {
      expect(call.prompt).not.toContain('\nRequirements list:\n');
      expect(call.prompt).not.toContain('covers:');
    }
    expect(body('review_requirements')).toBe('code-review-requirements\ndecision: ok\n');
    expect(body('review_report')).toContain('| — | — | ⏳ |');
  });
});
