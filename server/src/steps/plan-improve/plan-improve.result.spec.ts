import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resultAnswer } from '../../testing/result-answer';
import { improveSplit } from './plan-improve.step.spec-helpers';

const TASK = { id: 'a', title: 'Add it', depends: [], files: ['a.ts'], proof: 'a.spec.ts', description: 'Adds it.' };
const split = (tasks: unknown[]): string => resultAnswer('Done.', { summary: ['why'], contract: ['rule'], tasks });
const many = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ ...TASK, id: `t${n}`, files: [`f${n}.ts`] }));

describe('plan-improve step result block', () => {
  it.each(['plan', 'legacy'])('sends the full definition to the shared %s chat', async (received) => {
    const out = await improveSplit('PROJ-306', [resultAnswer('Done.', { summary: ['ok'] })], {
      split: false,
      tasks: false,
      received,
    });
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts[0]).toContain('The object has these fields, and no others:');
    expect(out.prompts[0]).toContain('- plan (array of string, optional)');
    expect(out.prompts[0]).not.toContain('End with the result block as before.');
  });

  it('sends only the result reminder to a chat that already received plan-improve', async () => {
    const out = await improveSplit('PROJ-307', [resultAnswer('Done.', { summary: ['ok'] })], {
      split: false,
      tasks: false,
      received: 'plan_improve',
    });
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts[0]).toContain('End with the result block as before.');
    expect(out.prompts[0]).not.toContain('The object has these fields, and no others:');
  });

  it('stores the four tasks of the f49 plan-improve answer with whole descriptions', async () => {
    const text = readFileSync(join(__dirname, '../plan/fixtures/f49-plan-improve.answer.md'), 'utf8');
    const out = await improveSplit('PROJ-300', [text]);
    const tasks = JSON.parse(out.subtasks ?? '[]');
    expect(tasks).toHaveLength(4);
    expect(tasks[3].description).toBe(
      'Add AGENTS.md with its structure rule. I restored this task:\n- one rule per line',
    );
  });

  it('merges an oversized plan into one that fits', async () => {
    const out = await improveSplit('PROJ-301', [split(many(2))], { stored: many(49) });
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts[0]).toContain('The plan has 49 tasks and the limit is 48.');
  });

  it('sends a bounded-limit error back in the follow-up even while merging', async () => {
    const out = await improveSplit('PROJ-302', [split(many(49)), split(many(48))], { stored: many(49) });
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts[1]).toContain('too many tasks: 49, the limit is 48');
  });

  it('keeps the plan on an empty plan, and turns a split back into one plan', async () => {
    const kept = await improveSplit('PROJ-303', [resultAnswer('Done.', { summary: ['ok'] })], { tasks: false });
    expect(JSON.parse(kept.requirements ?? '{}').plan.items).toEqual(['add the field']);
    const back = await improveSplit('PROJ-304', [resultAnswer('Done.', { summary: ['one'], plan: ['do it'] })]);
    expect(JSON.parse(back.subtasks ?? 'null')).toEqual([]);
    expect(JSON.parse(back.requirements ?? '{}').plan.items).toEqual(['do it']);
  });

  it('fails the step after a third invalid answer', async () => {
    const bad = split([{ ...TASK, depends: ['nope'] }]);
    const out = await improveSplit('PROJ-305', [bad, bad, bad]);
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('depends on unknown task nope');
    expect(out.prompts).toHaveLength(3);
  });
});
