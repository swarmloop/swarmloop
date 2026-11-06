import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { GOLDEN_DIR } from './step-trace.spec-helpers';

const STEP_CLASSES = [
  'research',
  'requirements',
  'plan',
  'plan-improve',
  'implement',
  'implement-improve',
  'code-review',
  'commit',
  'merge-request',
  'pipeline',
  'branch',
  'prepare',
];

interface Golden {
  visits?: { step: string }[];
  reads?: Record<string, string[]>;
}

const files = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'));
const text = (name: string): string => readFileSync(join(GOLDEN_DIR, name), 'utf8');

describe('golden files', () => {
  it.each(STEP_CLASSES)('has a golden for the %s step', (step) => {
    expect(files.some((name) => name.startsWith(`${step}.`))).toBe(true);
  });

  it('has four driver goldens', () => {
    expect(files.filter((name) => name.startsWith('run-driver.'))).toHaveLength(4);
  });

  it.each(files)('%s holds no absolute path, ISO timestamp or SHA', (name) => {
    const body = text(name);
    expect(body).not.toMatch(/(^|[\s"'=(:])\/(?:tmp|home|work|var|usr|root|private)\//);
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(body).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it.each(files)('%s lists the kinds read by every step it ran', (name) => {
    const golden = JSON.parse(text(name)) as Golden;
    for (const step of new Set((golden.visits ?? []).map((visit) => visit.step))) {
      expect(golden.reads?.[step]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
