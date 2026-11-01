import { SwarmloopError } from '../../swarmloop-error';
import { correctedPlan, parsePlan, planFromAgent, reviewedItems, withInstructions } from './plan-record';

describe('withInstructions', () => {
  it('appends the prompt and asks for a new plan only when asked', () => {
    const body = `${JSON.stringify({ prompt: 'Ship the field', plan: { name: 'Field', overview: '', items: ['add it'], decision: 'approve' } })}\n`;
    const revised = JSON.parse(withInstructions(body, 'Prefer the parser', true)) as { prompt: string; plan: { decision: string } };
    expect(revised.prompt).toBe('Ship the field\n\nPrefer the parser');
    expect(revised.plan.decision).toBe('revise');
    const kept = JSON.parse(withInstructions(body, 'Prefer the parser', false)) as { plan: { decision: string } };
    expect(kept.plan.decision).toBe('approve');
  });
});

describe('parsePlan', () => {
  it('keeps the checklist items', () => {
    const text = ['notes', 'plan:', '- add the field', '- cover the empty case', ''].join('\n');
    expect(parsePlan(text)).toBe('- add the field\n- cover the empty case\n');
  });

  it('keeps the last checklist when a resumed answer repeats the section', () => {
    const text = ['plan:', '- old item', '', 'plan:', '- new item', ''].join('\n');
    expect(parsePlan(text)).toBe('- new item\n');
  });

  it('rejects a missing or empty checklist', () => {
    expect(() => parsePlan('no section')).toThrow(new SwarmloopError('plan is missing'));
    expect(() => parsePlan('plan:\n- none\n')).toThrow(new SwarmloopError('plan is empty'));
  });
});

describe('planFromAgent', () => {
  it('reads the checklist from a plan tool when the answer has no section', () => {
    const stream = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        createPlanToolCall: {
          args: {
            name: 'Hello',
            overview: 'Print it.',
            plan: '# Hello\n\n- Add hello.js\n- Run it\n',
            todos: [{ content: 'Add hello.js that prints Hello World' }, { content: 'Run node hello.js' }],
          },
        },
      },
    });
    expect(planFromAgent('The worktree is empty.', stream)).toEqual({
      name: 'Hello',
      overview: 'Print it.',
      items: ['Add hello.js that prints Hello World', 'Run node hello.js'],
      decision: null,
    });
  });

  it('keeps the answer section ahead of a tool checklist', () => {
    const stream = JSON.stringify({
      type: 'tool_call',
      tool_call: { createPlanToolCall: { args: { todos: [{ content: 'from the tool' }] } } },
    });
    expect(planFromAgent('plan:\n- from the answer\n', stream)).toEqual({
      name: '',
      overview: '',
      items: ['from the answer'],
      decision: null,
    });
  });
});

describe('correctedPlan', () => {
  const body = `${JSON.stringify({ prompt: 'Ship the field', plan: { name: 'Field', overview: 'Ship it.', items: ['add the field'], decision: 'approve' } }, null, 2)}\n`;

  it('replaces the checklist with the stored plan object', () => {
    const plan = { name: 'Replacement', overview: 'From the log.', items: ['fix the failing test'], decision: 'approve' };
    const corrected = correctedPlan(body, ['plan:', JSON.stringify(plan, null, 2), ''].join('\n'));
    const record = JSON.parse(corrected?.requirements ?? '{}') as { plan?: { name?: string; overview?: string; items?: string[]; decision?: string } };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(record.plan?.name).toBe('Field');
    expect(record.plan?.overview).toBe('Ship it.');
    expect(record.plan?.decision).toBe('approve');
    expect(corrected?.handoff).toContain('dropped "add the field"');
    expect(corrected?.handoff).toContain('added "fix the failing test"');
  });

  it('still reads a bullet checklist', () => {
    const corrected = correctedPlan(body, 'plan:\n- fix the failing test\n');
    const record = JSON.parse(corrected?.requirements ?? '{}') as { plan?: { items?: string[] } };
    expect(record.plan?.items).toEqual(['fix the failing test']);
  });

  it('leaves the plan when the section is not a checklist', () => {
    expect(correctedPlan(body, 'plan:\nThe checklist stays.\n')).toBeNull();
    expect(correctedPlan(body, 'No plan section.\n')).toBeNull();
  });
});

describe('reviewedItems', () => {
  it('reads the checklist and ignores a decision line', () => {
    const text = ['plan:', '- add the field', 'decision: revise'].join('\n');
    expect(reviewedItems(text)).toEqual(['add the field']);
  });

  it('returns nothing when the review kept the given plan', () => {
    expect(reviewedItems('The checklist is already specific.')).toEqual([]);
  });

  it('reads a replacement from the plan tool', () => {
    const stream = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        createPlanToolCall: {
          args: {
            plan: '# Field\n\nAdd it in the mapper.\n',
            todos: [{ content: 'Add the field on the offer index' }, { content: 'Backfill null rows' }],
          },
        },
      },
    });
    expect(reviewedItems('I will replace the checklist.', stream)).toEqual(['Add the field on the offer index', 'Backfill null rows']);
  });
});
