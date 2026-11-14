import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { STEPS } from '../../contract/steps';
import { GOLDEN_DIR } from '../../testing/step-trace.spec-helpers';
import { ARTIFACTS, INSTRUCTIONS, REVIEWS, SERVICE_KINDS } from './artifacts';

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
});
