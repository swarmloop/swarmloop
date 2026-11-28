import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import type { OpenReviewRound } from '../../steps/shared/open-review-rounds';
import { phases } from './flow';

const ANGLES = ['requirements', 'code', 'behavior'];

type Chip = { status: string; current: boolean; note?: string };

/** The code-review chips of a running round that began after the stored answers, by chip name. */
function board(
  round: OpenReviewRound | undefined,
  logs: Record<string, string> = {},
  stored: Record<string, 'ok' | 'return'> = {},
): Record<string, Chip> {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-open-round-'));
  mkdirSync(join(root, 'data'));
  for (const [name, body] of Object.entries(logs)) {
    writeFileSync(join(root, 'data', `K-1-${name}-two-output.txt`), body);
  }
  const documents = Object.entries(stored).map(([angle, decision]) => ({
    stepStatId: 1,
    kind: `review_${angle}`,
    body: `old\ndecision: ${decision}\n`,
  })) as DocumentEntity[];
  const stats = [
    { id: 1, step: 'code-review', attempt: 1, status: 'waiting', stepStartedAt: new Date(1000).toISOString() },
  ] as StepStatEntity[];
  const run = {
    key: 'K-1',
    status: 'running',
    currentStep: 'code-review',
    activeAttempt: 'two',
    stepStartedAt: new Date(5000).toISOString(),
  } as RunEntity;
  const steps = phases(run, stats, documents, root, [], round).find((phase) => phase.phase === 'code-review')!.steps;
  return Object.fromEntries(steps.map((step) => [step.name, step as Chip]));
}

const shown = (chips: Record<string, Chip>, name: string): [string, boolean] => [
  chips[name].status,
  chips[name].current,
];

describe('chips of an open code-review round', () => {
  const only: OpenReviewRound = { reviewers: ['requirements'], reportDue: false, reportStarted: false };
  const stored = { code: 'ok', behavior: 'return' } as const;

  it('shows a Run again reviewer as preparing, then running, and the others as stored', () => {
    expect(shown(board(only, {}, stored), 'code-review-requirements')).toEqual(['preparing', true]);
    const chips = board(only, { 'code-review-requirements': 'starting\n' }, stored);
    expect(shown(chips, 'code-review-requirements')).toEqual(['running', true]);
    expect(shown(chips, 'code-review-code')).toEqual(['done', false]);
    expect(shown(chips, 'code-review-behavior')).toEqual(['done', false]);
  });

  it('shows the stored status of the report when the round does not write it', () => {
    expect(shown(board(only, { 'code-review-requirements': 'starting\n' }, stored), 'code-review')).toEqual([
      'done',
      false,
    ]);
  });

  it('shows reviewers kept from stored answers as stored and the others as running', () => {
    const round: OpenReviewRound = {
      reviewers: ['requirements', 'code'],
      reportDue: true,
      reportStarted: false,
    };
    const chips = board(round, { 'code-review-code': 'starting\n' }, { behavior: 'return' });
    expect(shown(chips, 'code-review-behavior')).toEqual(['done', false]);
    for (const name of ['requirements', 'code']) {
      expect(shown(chips, `code-review-${name}`)).toEqual(['running', true]);
    }
  });

  it("shows today's chips when the server has no open round", () => {
    const logs = { 'code-review-code': 'starting\n' };
    const chips = board(undefined, logs, stored);
    for (const name of ANGLES) {
      expect(shown(chips, `code-review-${name}`)).toEqual(['running', true]);
    }
    expect(shown(chips, 'code-review')).toEqual(['running', true]);
  });

  it('shows a due report as waiting for the running reviewers until its agent starts, then running', () => {
    const round: OpenReviewRound = { reviewers: ['code', 'behavior'], reportDue: true, reportStarted: false };
    const waiting = board(round, { 'code-review-code': 'starting\n' }, { requirements: 'ok' })['code-review'];
    expect(waiting).toMatchObject({ status: 'waiting', current: false, note: 'waits for code and behavior' });
    const started = board({ ...round, reportStarted: true }, { 'code-review-report': 'starting\n' })['code-review'];
    expect(started).toMatchObject({ status: 'running', current: true });
  });

  it('shows the three reviewers of a new round on a run the retired five reviewed before', () => {
    const round: OpenReviewRound = { reviewers: ANGLES, reportDue: true, reportStarted: false };
    const chips = board(round, {}, { quality: 'return', security: 'ok' });
    expect(Object.keys(chips)).toEqual([
      'code-review-requirements',
      'code-review-code',
      'code-review-behavior',
      'code-review',
    ]);
    expect(shown(chips, 'code-review-code')).toEqual(['preparing', true]);
    expect(Object.keys(board(undefined, {}, { quality: 'return' }))).toContain('code-review-quality');
  });
});
