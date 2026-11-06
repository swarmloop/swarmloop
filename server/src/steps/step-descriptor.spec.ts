import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StepName } from '../contract/steps';
import { GOLDEN_DIR } from '../testing/step-trace.spec-helpers';
import { boot } from './prepare/prepare.step.spec-helpers';
import { StepRegistry } from './step.registry';

const MIGRATED = [
  'requirements',
  'prepare',
  'branch',
  'commit',
  'merge-request',
  'pipeline',
  'research',
  'plan',
  'plan-improve',
  'implement',
  'implement-improve',
  'code-review',
] as const;

/**
 * Every kind a step read in any of its golden traces. `handoff` is the base step's own read, and `*` lists every
 * document, so neither is a declared input.
 */
function goldenReads(step: string): string[] {
  const kinds = new Set<string>();
  for (const name of readdirSync(GOLDEN_DIR).filter((file) => file.startsWith(`${step}.`))) {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as { reads?: Record<string, string[]> };
    for (const kind of golden.reads?.[step] ?? []) {
      kinds.add(kind);
    }
  }
  kinds.delete('handoff');
  kinds.delete('*');
  return [...kinds].sort();
}

describe('step descriptors', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-descriptor-'));
    app = await boot(root);
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(MIGRATED)('%s declares the kinds its golden traces read, and a start guard no golden reads', (step) => {
    const described = app
      .get(StepRegistry)
      .describe({} as never)
      .find((item) => item.name === (step as StepName));
    const declared = new Set(described?.inputs.map((input) => input.kind));
    const golden = goldenReads(step);
    expect(golden.filter((kind) => !declared.has(kind))).toEqual([]);
    const guards = (described?.inputs ?? []).filter((input) => !golden.includes(input.kind)).map((input) => input.need);
    expect(guards.every((need) => need === 'start')).toBe(true);
  });

  it('lists the outputs of a step it migrated', () => {
    const described = app.get(StepRegistry).describe({} as never);
    const kinds = (step: string) => described.find((item) => item.name === step)?.outputs;
    expect(kinds('commit')).toEqual(['commit', 'pipeline_ref', 'ci_skip']);
    expect(kinds('pipeline')).toEqual(['pipeline_log', 'return', 'pipeline_rebases']);
    expect(kinds('merge-request')).toEqual(['merge_request', 'rebase_merge_skip']);
    expect(kinds('branch')).toEqual([]);
  });
});
