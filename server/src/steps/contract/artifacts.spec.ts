import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { STEPS } from '../../contract/steps';
import { GOLDEN_DIR } from '../../testing/step-trace.spec-helpers';
import { ARTIFACTS, INSTRUCTIONS, REVIEWS, REVIEW_RESULTS, SERVICE_KINDS } from './artifacts';
import { CODE_REVIEWERS } from '../../contract/steps';

interface Golden {
  reads?: Record<string, string[]>;
}

const entries = Object.values(ARTIFACTS);
const families = [INSTRUCTIONS, REVIEWS];
const files = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'));
const goldens = files.map((name) => ({ name, golden: JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) }));

function documentsIn(value: unknown): { kind: string; body: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap(documentsIn);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const own = typeof record.kind === 'string' && typeof record.body === 'string' ? [record as never] : [];
    return [...own, ...Object.values(record).flatMap(documentsIn)];
  }
  return [];
}

const isService = (kind: string): boolean =>
  Object.keys(SERVICE_KINDS).some((owned) => kind === owned || kind.startsWith(`${owned}:`));
const isKnown = (kind: string): boolean =>
  entries.some((entry) => entry.kind === kind) || families.some((family) => family.matches(kind)) || isService(kind);

describe('artifact catalog', () => {
  it('lists every kind once', () => {
    const kinds = [
      ...entries.map((entry) => entry.kind),
      ...families.flatMap((family) => family.kinds),
      ...Object.keys(SERVICE_KINDS),
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('registers the requirement list and its coverage with their writers and readers', () => {
    expect(ARTIFACTS.requirementList).toMatchObject({
      kind: 'requirement_list',
      writers: ['research', 'plan-improve'],
      readers: ['research', 'plan', 'plan-improve', 'code-review'],
    });
    expect(ARTIFACTS.requirementCoverage).toMatchObject({
      kind: 'requirement_coverage',
      writers: ['plan', 'plan-improve'],
      readers: ['plan-improve', 'implement', 'code-review'],
    });
  });

  it('round-trips the requirement list and its coverage through their codecs', () => {
    const list = [{ id: 'R1', text: 'first' }];
    const covered = [{ id: 'R1', text: 'first', items: ['item'] }];
    expect(ARTIFACTS.requirementList.parse(ARTIFACTS.requirementList.format(list))).toEqual(list);
    expect(ARTIFACTS.requirementCoverage.parse(ARTIFACTS.requirementCoverage.format(covered))).toEqual(covered);
    expect(ARTIFACTS.requirementList.summarize(list)).toBe('1 requirements: first');
    expect(ARTIFACTS.requirementCoverage.summarize([])).toBe('0 requirements');
  });

  it.each(entries.map((entry) => [entry.kind, entry] as const))('%s has a writer or is external', (_kind, entry) => {
    expect(entry.writers.length > 0 || entry.external === true).toBe(true);
  });

  it.each(entries.map((entry) => [entry.kind, entry] as const))('%s names only known steps', (_kind, entry) => {
    for (const step of [...entry.writers, ...entry.readers]) {
      expect(STEPS).toContain(step);
    }
  });

  it.each(goldens.map(({ name, golden }) => [name, golden] as const))(
    '%s round-trips every document body through its codec',
    (_name, golden) => {
      for (const { kind, body } of documentsIn(golden)) {
        const entry = entries.find((item) => item.kind === kind);
        if (entry) {
          expect(entry.format(entry.parse(body) as never)).toBe(body);
        }
      }
    },
  );

  it.each(goldens.map(({ name, golden }) => [name, golden] as const))(
    '%s holds only cataloged kinds',
    (_name, golden) => {
      for (const { kind } of documentsIn(golden)) {
        expect(isKnown(kind)).toBe(true);
      }
    },
  );

  it.each(goldens.map(({ name, golden }) => [name, golden as Golden] as const))(
    '%s reads only kinds listed with the reading step',
    (_name, golden) => {
      for (const [key, kinds] of Object.entries(golden.reads ?? {})) {
        const step = key.replace(/^code-review-.*/, 'code-review');
        for (const kind of kinds.filter((item) => item !== '*')) {
          const entry = entries.find((item) => item.kind === kind);
          if (entry) {
            expect(entry.readers).toContain(step);
          } else {
            expect(families.some((family) => family.matches(kind)) || isService(kind)).toBe(true);
          }
        }
      }
    },
  );

  it('registers the question parts for the two steps that ask a person', () => {
    expect(ARTIFACTS.questionParts).toMatchObject({
      kind: 'question_parts',
      writers: ['code-review', 'implement'],
      readers: ['implement'],
    });
    const parts = { decide: 'Is it?', sides: [], full: '', askedAt: '2026-11-15T07:11:43.444Z' };
    const stored = [{ question: 'Q', parts }];
    expect(ARTIFACTS.questionParts.parse(ARTIFACTS.questionParts.format(stored))).toEqual(stored);
    expect(ARTIFACTS.questionParts.summarize(stored)).toBe('1 questions: Is it?');
  });

  it('subtasks and contract are registered', () => {
    expect(ARTIFACTS.subtasks.kind).toBe('subtasks');
    expect(ARTIFACTS.subtasks.writers).toEqual(['plan', 'plan-improve', 'implement']);
    expect(ARTIFACTS.contract.kind).toBe('contract');
    expect(ARTIFACTS.contract.readers).toContain('implement');
  });

  it('registers the research result for the steps that read it', () => {
    const entry = ARTIFACTS.researchResult;
    expect(entry.kind).toBe('research_result');
    expect(entry.writers).toEqual(['research']);
    expect(entry.readers).toEqual(['plan', 'plan-improve', 'code-review']);
    const value = { summary: ['why'], questions: ['a: b?'], impact: [], needs: [{ id: 't', what: 'x' }] };
    expect(entry.parse(entry.format(value))).toEqual(value);
    expect(() => entry.parse('{"summary":[]}')).toThrow('research_result is not valid');
  });

  it.each(CODE_REVIEWERS)('registers the %s review result with a codec that checks it', (reviewer) => {
    const entry = REVIEW_RESULTS[reviewer];
    expect(entry.kind).toBe(`review_${reviewer}_result`);
    expect(Object.values(ARTIFACTS)).toContain(entry);
    expect(entry.writers).toEqual(['code-review']);
    const value = { decision: 'return' as const, review: 'The parser drops a segment.', summary: ['one'] };
    expect(entry.parse(entry.format(value))).toEqual(value);
    expect(() => entry.parse('{"decision":"approve","review":"x","summary":[]}')).toThrow(
      `review_${reviewer}_result is not valid`,
    );
    expect(() => entry.parse('{"decision":"ok","summary":[]}')).toThrow('review');
  });

  it('registers the plan, plan-improve and subtask answer results', () => {
    expect([ARTIFACTS.planResult.kind, ARTIFACTS.planImproveResult.kind, ARTIFACTS.subtaskAnswerResult.kind]).toEqual([
      'plan_result',
      'plan_improve_result',
      'subtask_answer_result',
    ]);
    expect(ARTIFACTS.planResult.writers).toEqual(['plan']);
    expect(ARTIFACTS.planImproveResult.writers).toEqual(['plan-improve']);
    expect(ARTIFACTS.subtaskAnswerResult.external).toBe(true);
    const value = {
      summary: ['why'],
      plan: ['a - files: b: c'],
      covers: [],
      questions: [],
      contract: [],
      tasks: [],
      keep: [],
    };
    expect(ARTIFACTS.planResult.parse(ARTIFACTS.planResult.format(value))).toEqual(value);
    expect(() => ARTIFACTS.planResult.parse('{"summary":[],"plan":[],"questions":["a?"]}')).not.toThrow();
    expect(() => ARTIFACTS.planResult.parse('{"summary":[]}')).toThrow('plan_result is not valid');
    expect(() => ARTIFACTS.planImproveResult.parse('{"summary":[],"plan":["a"],"tasks":[{"id":"a"}]}')).toThrow(
      'plan_improve_result is not valid',
    );
    expect(ARTIFACTS.subtaskAnswerResult.parse('{"answer":"use it"}')).toEqual({ answer: 'use it' });
  });

  it('summarizes a pipeline ref by the branch or commit it watches', () => {
    const summarize = (body: string): string => ARTIFACTS.pipelineRef.summarize(body);
    expect(summarize('project: a\nref: feature/PROJ-300-ship')).toBe('feature/PROJ-300-ship');
    expect(summarize('project: a\nref: feature/a\nsha: abc1234def')).toBe('feature/a at abc1234');
    expect(summarize('project: a\nref: feature/a\nproject: b\nref: feature/b\nsha: 1234567890')).toBe(
      'feature/a, feature/b at 1234567',
    );
    expect(summarize('nothing here\nsecond')).toBe('nothing here');
  });
});
