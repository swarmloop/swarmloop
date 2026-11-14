import { SwarmloopError } from '../../core/swarmloop-error';
import {
  correctedPlan,
  planFields,
  readPlan,
  renderSummary,
  requireApprovedPlan,
  withInstructions,
  withPlan,
} from './plan-record';

describe('withInstructions', () => {
  it('appends the prompt and asks for a new plan only when asked', () => {
    const body = `${JSON.stringify({ prompt: 'Ship the field', plan: { name: 'Field', overview: '', items: ['add it'], decision: 'approve' } })}\n`;
    const revised = JSON.parse(withInstructions(body, 'Prefer the parser', true)) as {
      prompt: string;
      plan: { decision: string };
    };
    expect(revised.prompt).toBe('Ship the field\n\nPrefer the parser');
    expect(revised.plan.decision).toBe('revise');
    const kept = JSON.parse(withInstructions(body, 'Prefer the parser', false)) as { plan: { decision: string } };
    expect(kept.plan.decision).toBe('approve');
  });
});

describe('correctedPlan', () => {
  const body = `${JSON.stringify({ prompt: 'Ship the field', plan: { name: 'Field', overview: 'Ship it.', items: ['add the field'], decision: 'approve' } }, null, 2)}\n`;

  it('replaces the checklist and names what changed, keeping the name and overview', () => {
    const corrected = correctedPlan(body, ['fix the failing test'], ['add the field']);
    const record = JSON.parse(corrected?.requirements ?? '{}') as {
      plan?: { name?: string; overview?: string; items?: string[]; decision?: string };
    };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(record.plan?.name).toBe('Field');
    expect(record.plan?.overview).toBe('Ship it.');
    expect(record.plan?.decision).toBe('approve');
    expect(corrected?.handoff).toContain('dropped "add the field"');
    expect(corrected?.handoff).toContain('added "fix the failing test"');
  });

  it('does not report a change for an equal checklist', () => {
    const item = 'add the field - files: a.ts - proof: a.spec.ts "adds it"';
    expect(correctedPlan(body, [item], [item])).toBeNull();
  });

  it('leaves the plan when the answer sent no checklist', () => {
    expect(correctedPlan(body, undefined, ['add the field'])).toBeNull();
    expect(correctedPlan(body, [], ['add the field'])).toBeNull();
  });
});

describe('the plan in the requirements record', () => {
  const requirements = '{"prompt":"ship the field"}\n';

  it('is written from the checklist the planner sent, as the prose reader wrote it', () => {
    const body = withPlan(requirements, planFields(['add the field', 'cover the empty case']));
    expect(JSON.parse(body)).toEqual({
      prompt: 'ship the field',
      plan: { name: '', overview: '', items: ['add the field', 'cover the empty case'], decision: null },
    });
    expect(readPlan(body)?.items).toEqual(['add the field', 'cover the empty case']);
  });

  it('keeps the name and overview a planner sent', () => {
    expect(planFields(['a'], 'Field', 'Ship it.')).toEqual({
      name: 'Field',
      overview: 'Ship it.',
      items: ['a'],
      decision: null,
    });
  });

  it('is approved only by a person: the plan of a plan answer is not', () => {
    const body = withPlan(requirements, planFields(['a']));
    expect(() => requireApprovedPlan(readPlan(body))).toThrow(new SwarmloopError('plan is not approved'));
    expect(() => requireApprovedPlan(readPlan(requirements))).toThrow(new SwarmloopError('plan is missing'));
  });
});

describe('renderSummary', () => {
  it('writes one bullet per line the agent sent, and the checklist when it sent none', () => {
    expect(renderSummary(['covers the empty case', 'one run'], ['item'])).toBe('- covers the empty case\n- one run\n');
    expect(renderSummary([], ['item', 'other'])).toBe('- item\n- other\n');
    expect(renderSummary(['none'], ['item'])).toBe('- item\n');
  });
});
