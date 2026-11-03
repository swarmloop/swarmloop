import { describe, expect, it } from 'vitest';
import { flowView } from '../test/fixtures';
import { applyFlow, applyReviewLog, type FlowMemory } from './flow-state';

function memory(overrides: Partial<FlowMemory> = {}): FlowMemory {
  return { pinnedAt: null, heldMs: 0, heldStart: null, openReviews: new Set(), ...overrides };
}

function review(status = 'idle', name = 'code-review-quality') {
  return flowView({
    currentStep: 'code-review',
    phases: [{ phase: 'code-review', steps: [{ name, status, current: false, attempts: 0 }] }],
  });
}

describe('applyFlow', () => {
  it.each(['implement', 'code-review'])('pins a stale waiting snapshot for %s', (currentStep) => {
    const current = flowView({ currentStep });
    const state = memory({ pinnedAt: current.updatedAt, heldMs: 10, heldStart: 'start' });
    const result = applyFlow(current, flowView({ status: 'waiting' }), state);
    expect(result.flow).toBe(current);
    expect(result.memory).toBe(state);
  });

  it.each(['running', 'failed'])('releases a pin for a %s snapshot', (status) => {
    const result = applyFlow(flowView(), flowView({ status }), memory({ pinnedAt: 'old' }));
    expect(result.flow?.status).toBe(status);
    expect(result.memory.pinnedAt).toBeNull();
  });

  it.each([false, true])('holds elapsed time until the visit is stored: %s', (stored) => {
    const body = flowView();
    body.metrics.closedStarts = stored ? ['start'] : ['other'];
    const state = memory({ heldMs: 1500, heldStart: 'start' });
    const result = applyFlow(null, body, state);
    expect(result.memory.heldMs).toBe(stored ? 0 : 1500);
    expect(result.memory.heldStart).toBe(stored ? null : 'start');
    expect(state.heldMs).toBe(1500);
    expect(result.flow).toEqual(body);
  });

  it.each([{ status: 'waiting' }, { currentStep: 'implement' }])('clears reviews outside review: %o', (overrides) => {
    const state = memory({ openReviews: new Set(['code-review-quality']) });
    const body = { ...review(), ...overrides };
    const result = applyFlow(null, body, state);
    expect([...result.memory.openReviews]).toEqual([]);
    expect(result.flow).toEqual(body);
    expect([...state.openReviews]).toEqual(['code-review-quality']);
  });

  it.each(['idle', 'failed'])('keeps an open %s reviewer live without mutating inputs', (status) => {
    const body = review(status);
    const state = memory({ openReviews: new Set(['code-review-quality']) });
    const result = applyFlow(null, body, state);
    expect(result.flow?.phases[0].steps[0]).toMatchObject({ status: 'running', current: true });
    expect([...result.memory.openReviews]).toEqual(['code-review-quality']);
    expect(body.phases[0].steps[0].status).toBe(status);
  });

  it.each(['done', 'waiting'])('removes a finished %s reviewer from memory', (status) => {
    const result = applyFlow(null, review(status), memory({ openReviews: new Set(['code-review-quality']) }));
    expect(result.flow?.phases[0].steps[0].status).toBe(status);
    expect([...result.memory.openReviews]).toEqual([]);
  });
});

describe('applyReviewLog', () => {
  it.each(['decision: return\nprocess exited 0', 'process killed: timeout'])(
    'keeps done chips finished for %s',
    (body) => {
      const current = review('done');
      const result = applyReviewLog(current, memory(), { key: current.key, step: 'code-review-quality', body });
      expect(result.flow?.phases[0].steps[0]).toEqual(current.phases[0].steps[0]);
      expect([...result.memory.openReviews]).toEqual([]);
    },
  );

  it.each([
    ['decision: ok\nprocess exited 0', 'done'],
    ['decision: return\nprocess exited 0', 'waiting'],
    ['process killed: timeout', 'failed'],
  ])('finishes a chip from %s', (body, status) => {
    const current = review('running');
    const state = memory({ openReviews: new Set(['code-review-quality']) });
    const result = applyReviewLog(current, state, { key: current.key, step: 'code-review-quality', body });
    expect(result.flow?.phases[0].steps[0]).toMatchObject({ status, current: false });
    expect([...result.memory.openReviews]).toEqual([]);
    expect([...state.openReviews]).toEqual(['code-review-quality']);
    expect(current.phases[0].steps[0].status).toBe('running');
  });

  it.each(['code-review-quality', 'code-review-report'])('makes %s live', (step) => {
    const name = step === 'code-review-report' ? 'code-review' : step;
    const current = review('idle', name);
    const result = applyReviewLog(current, memory(), { key: current.key, step, body: 'working' });
    expect(result.flow?.phases[0].steps[0]).toMatchObject({ name, status: 'running', current: true });
    expect([...result.memory.openReviews]).toEqual([name]);
    expect(current.phases[0].steps[0].status).toBe('idle');
  });

  it.each(['waiting for output', ' waiting for output\n', 'starting', ' starting\n', '', '  '])(
    'ignores placeholder %j',
    (body) => {
      const current = review();
      const state = memory({ openReviews: new Set(['code-review-quality']) });
      const result = applyReviewLog(current, state, { key: current.key, step: 'code-review-quality', body });
      expect(result.flow).toBe(current);
      expect(result.memory).toEqual(state);
    },
  );

  it.each([null, flowView({ status: 'waiting' }), flowView()])(
    'records live memory before a reviewing flow',
    (current) => {
      const result = applyReviewLog(current, memory(), { key: 'run-1', step: 'code-review-quality', body: 'working' });
      expect(result.flow).toBe(current);
      expect([...result.memory.openReviews]).toEqual(['code-review-quality']);
    },
  );
});
