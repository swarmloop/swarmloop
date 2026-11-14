import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { requirementsView } from '../../contract/requirements-view';
import { ARTIFACTS, summarizePlan, summarizeReview } from './artifacts';
import type { Subtask } from '../../contract/subtask';
import type { Artifact } from './artifact';

const GOLDEN_DIR = join(__dirname, '..', '..', 'testing', 'golden');

interface Golden {
  documentsOutsideVisits: { kind: string; body: string }[];
  visits: { documents: { kind: string; body: string }[] }[];
}

/** The first body of each kind that the golden runs stored. */
function goldenBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const file of readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'))) {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as Golden;
    for (const document of [...golden.documentsOutsideVisits, ...golden.visits.flatMap((visit) => visit.documents)]) {
      if (!bodies.has(document.kind)) {
        bodies.set(document.kind, document.body);
      }
    }
  }
  return bodies;
}

/** A kind no golden run stores, whose body is JSON. */
const JSON_BODIES: Record<string, string> = {
  answer_errors: '["items: \\"items\\" is required"]\n',
  subtask_answer_result: '{"answer":"use the shared helper"}\n',
};

const bodies = goldenBodies();
const entries = Object.values<Artifact<unknown>>(ARTIFACTS);

describe('Artifact.summarize', () => {
  it.each(entries.map((entry) => [entry.kind, entry] as const))(
    'tells what a %s document holds in one short line',
    (kind, entry) => {
      const body = bodies.get(kind) ?? JSON_BODIES[kind] ?? 'first line\nsecond line\n';
      const line = entry.summarize(entry.parse(body));
      expect(line.length > 0).toBe(body.trim() !== '');
      expect(line.length).toBeLessThanOrEqual(160);
      expect(line).not.toContain('\n');
      expect(line).not.toMatch(/^[[{]$/);
    },
  );

  it('subtasks summary', () => {
    const task: Subtask = {
      id: 'a',
      title: 'Add it',
      description: '',
      depends: [],
      files: [],
      proof: 'p',
      status: 'pending',
    };
    expect(ARTIFACTS.subtasks.summarize([task, task])).toBe('2 tasks: Add it');
  });

  it('gives the title of the requirements of a run with a ticket, not its first bracket', () => {
    const body = bodies.get('requirements') ?? '';
    expect(body.startsWith('{')).toBe(true);
    expect(ARTIFACTS.requirements.summarize(body)).toBe('PROJ-30 Ship the field');
  });

  it('gives the first line of the prompt for a run with only a prompt', () => {
    expect(ARTIFACTS.requirements.summarize('{"prompt":"## Run lifecycle l13: one path\\nmore"}\n')).toBe(
      'Run lifecycle l13: one path',
    );
  });

  it('names a plan by its checklist, a review by its decision, a pipeline log by its result', () => {
    const plan = JSON.stringify({ prompt: 'x', plan: { name: 'n', overview: 'o', items: ['one', 'two'] } });
    expect(summarizePlan(plan)).toBe('2 checklist items: one');
    expect(summarizeReview('Missing a test\ndecision: return\n')).toBe('decision: return · Missing a test');
    expect(ARTIFACTS.pipelineLog.summarize('result: pass\nproject: a\n')).toBe('pass');
    expect(ARTIFACTS.pipelineLog.summarize('result: fail\nproject: a\njob: unit\nstage: test\n')).toBe('fail: unit');
    expect(ARTIFACTS.issues.summarize([{ id: 'a', source: 'pipeline', title: 'unit failed', body: 'log' }])).toBe(
      '1 issues: unit failed',
    );
    expect(ARTIFACTS.repos.summarize(['api', 'web'])).toBe('api, web');
  });

  it('reads the requirements record for the title, the counts and the approval of the plan', () => {
    const view = requirementsView(
      JSON.stringify({
        tickets: [{ key: 'PROJ-1', summary: 'Do it' }],
        pages: [{ title: 'Doc' }],
        plan: { name: 'p', overview: '', items: ['a'], decision: 'approve' },
      }),
    );
    expect(view).toMatchObject({
      title: 'PROJ-1 Do it',
      meta: '1 tickets · 1 pages · plan: 1 items',
      approval: 'plan approved',
    });
    expect(requirementsView('not json')).toBeNull();
  });
});
