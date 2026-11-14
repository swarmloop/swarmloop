import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { RESULT_AS_BEFORE } from '../../agent-result/result-prompt';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer, reviewLog } from '../../testing/result-answer';
import { reviewDocuments, opinionOf } from './code-review-record';
import { tallyRound } from './review-round';
import { selectReviewers } from './review-select';
import { answerFor, boot, reportReply, result, seed, writeEnv } from './code-review.step.spec-helpers';

const SUMMARY_REVIEW = 'Looked at the parser.\n\nsummary:\n- the parser keeps the segment';

const KINDS = ['review_quality', 'review_quality_result', 'review_report', 'review_report_result', 'handoff'];

/** Runs one code-review round. A step's script is answered in order, then every later launch gets the default answer. */
async function round(key: string, scripts: Record<string, string[]> = {}, chat = false) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-result-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  if (chat) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', `${key}-code-review-quality-session.json`),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'quality-chat', resumed: true, completed: true, killReason: null, usd: 3, resultName: 'review_quality' })}\n`,
    );
  }
  const queues = new Map(Object.entries(scripts).map(([step, answers]) => [step, [...answers]]));
  const agent = jest.fn(async (input: AgentRunInput) =>
    result(queues.get(input.step.replace('code-review-', ''))?.shift() ?? answerFor(input.step), input.step),
  );
  const app = await boot(root, agent);
  try {
    await seed(app, key);
    const done = await app.get(PipelineService).step('code-review', key);
    const documents = app.get(DocumentRepository);
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

const block = (decision: string, review = 'notes') => resultAnswer(review, { decision, review, summary: [] });

describe('code-review step result blocks', () => {
  it('takes the decision of the block, not the one the prose says', async () => {
    const { done, body } = await round('PROJ-401', {
      quality: [`decision: return\n\n${block('ok', 'Checked the parser.')}`],
    });
    expect(done.exitCode).toBe(0);
    expect(body('review_quality')).toBe('Checked the parser.\ndecision: ok\n');
    expect(JSON.parse(body('review_quality_result') ?? '{}')).toMatchObject({ decision: 'ok' });
  });

  it('stores the review as the review text followed by the decision line, and the result next to it', async () => {
    const review = resultAnswer('prose', {
      decision: 'ok',
      review: SUMMARY_REVIEW,
      summary: ['the parser keeps the segment'],
    });
    const { body } = await round('PROJ-402', { quality: [review] });
    expect(body('review_quality')).toBe(`${SUMMARY_REVIEW}\ndecision: ok\n`);
    expect(JSON.parse(body('review_quality_result') ?? '{}')).toEqual({
      decision: 'ok',
      review: SUMMARY_REVIEW,
      summary: ['the parser keeps the segment'],
    });
  });

  it('stores the report as sections and its result, and gives the handoff the summary of each review', async () => {
    const { body } = await round('PROJ-403', {
      report: [reportReply('Every check is ok.')],
      security: [
        resultAnswer('p', { decision: 'ok', review: 'Checked queries.', summary: ['queries are parameterized'] }),
      ],
    });
    expect(body('review_report')).toBe(
      '## What changed\n\nchanged the field\n\n## Code review\n\nEvery check is ok.\n',
    );
    expect(JSON.parse(body('review_report_result') ?? '{}')).toEqual({
      whatChanged: 'changed the field',
      codeReview: 'Every check is ok.',
    });
    expect(body('handoff')).toContain('queries are parameterized');
  });

  it('sends every error back once and takes the fixed block', async () => {
    const { done, calls } = await round('PROJ-404', { quality: ['no block here', block('ok')] });
    expect(done.exitCode).toBe(0);
    const quality = calls.filter((call) => call.step === 'code-review-quality');
    expect(quality).toHaveLength(2);
    expect(quality[1].prompt).toContain('The result block of your last answer was not accepted');
    expect(quality[1].prompt).toContain('no result block');
    expect(quality[1].prompt).toContain(RESULT_AS_BEFORE);
  });

  it('fails the step after a third invalid answer and names the errors', async () => {
    const wrong = block('approve');
    const { done, calls, body } = await round('PROJ-405', { quality: [wrong, 'no block', wrong, wrong] });
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain("the agent's result was not accepted");
    expect(done.message).toContain('decision');
    expect(calls.filter((call) => call.step === 'code-review-quality')).toHaveLength(3);
    expect(body('review_quality')).toBeNull();
  });

  it('asks a fresh chat for the whole result and a continued chat with one line', async () => {
    const fresh = await round('PROJ-406');
    const first = fresh.calls.find((call) => call.step === 'code-review-quality');
    expect(first?.prompt).toContain('- decision (one of "ok", "return", required)');
    expect(first?.prompt).toContain('- summary (array of string, required)');
    const continued = await round('PROJ-407', {}, true);
    const next = continued.calls.find((call) => call.step === 'code-review-quality');
    expect(next?.resumeChatId).toBe('quality-chat');
    expect(next?.prompt).toContain(RESULT_AS_BEFORE);
    expect(next?.prompt).not.toContain('- decision (one of');
    const report = continued.calls.find((call) => call.step === 'code-review-report');
    expect(report?.prompt).toContain('- whatChanged (string, required)');
  });
});

describe('a reviewer killed after its block', () => {
  it('recovers a block that carries the reason of a reviewer answering implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-killed-reason-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const answer = resultAnswer('Still so.', {
      decision: 'return',
      review: 'Still so.',
      summary: [],
      reason: 'The finding still holds.',
    });
    const log = `${JSON.stringify({ type: 'result', result: answer })}\nprocess exited 0\n`;
    writeFileSync(join(root, 'data', 'PROJ-412-code-review-quality-aaa-output.txt'), log);
    const documents = { latestBody: async () => null } as unknown as DocumentRepository;
    const selection = await selectReviewers(documents, root, {
      key: 'PROJ-412',
      only: undefined,
      fresh: false,
      retry: true,
      same: false,
      attemptId: 'aaa',
      counts: async () => false,
    });
    const kept = selection.kept.find((item) => item.kind === 'review_quality');
    expect(kept?.decision).toBe('return');
    expect(kept?.body).toBe('Still so.\ndecision: return\nreason: The finding still holds.\n');
  });

  it('counts the block of the interrupted attempt and stores its result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-killed-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'PROJ-410-code-review-quality-aaa-output.txt'), reviewLog('return', 'Found it.'));
    const documents = { latestBody: async () => null } as unknown as DocumentRepository;
    const selection = await selectReviewers(documents, root, {
      key: 'PROJ-410',
      only: undefined,
      fresh: false,
      retry: true,
      same: false,
      attemptId: 'aaa',
      counts: async () => false,
    });
    const kept = selection.kept.find((item) => item.kind === 'review_quality');
    expect(kept?.decision).toBe('return');
    expect(selection.pending.map((reviewer) => reviewer.name)).not.toContain('quality');
    expect(selection.recovered.map((document) => document.kind)).toEqual(['review_quality', 'review_quality_result']);
    expect(selection.recovered).toEqual(reviewDocuments(opinionOf('review_quality', kept!.result)));
  });
});

describe('a stored return on an unchanged diff', () => {
  const returned = { decision: 'return' as const, review: 'Authentication is missing.', summary: [] };

  it('is not kept, so its reviewer decides again', async () => {
    const stored = JSON.stringify(returned);
    const documents = {
      latestBody: async (_key: string, kind: string) => (kind === 'review_quality_result' ? stored : null),
    } as unknown as DocumentRepository;
    const selection = await selectReviewers(documents, '/none', {
      key: 'PROJ-411',
      only: undefined,
      fresh: false,
      retry: false,
      same: true,
      attemptId: null,
      counts: async () => true,
    });
    expect(selection.kept.map((item) => item.kind)).not.toContain('review_quality');
    expect(selection.pending.map((reviewer) => reviewer.name)).toContain('quality');
  });

  it('is counted, stored and reported with the decision the reviewer gave', () => {
    const kept = opinionOf('review_quality', returned);
    const tally = tallyRound([kept], [], []);
    expect(tally.opinions.map((item) => item.decision)).toEqual(['return']);
    expect(tally.opinions[0].body).toBe('Authentication is missing.\ndecision: return\n');
  });
});
