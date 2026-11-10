import { CODE_REVIEWERS, STEPS } from '../contract/steps';
import { testEnv } from './env.spec-helpers';
import { agentFor, assertAgents, parseAgentList, ROLE_OF_STEP, roleOf, runtimesInUse } from './agents';

const KEYS = { CURSOR_API_KEY: 'c', ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'x' };
const NO_AGENT = ['requirements', 'prepare', 'branch', 'commit', 'pipeline', 'done'];

describe('parseAgentList', () => {
  it('keeps the order and trims spaces', () => {
    expect(parseAgentList('AGENTS_PLAN', ' claude:claude-opus-5-5 , codex:gpt-6.1-sol,cursor:grok-4.7-high ')).toEqual([
      { runtime: 'claude', model: 'claude-opus-5-5' },
      { runtime: 'codex', model: 'gpt-6.1-sol' },
      { runtime: 'cursor', model: 'grok-4.7-high' },
    ]);
  });

  it('names the agent with an unknown runtime', () => {
    expect(() => parseAgentList('AGENTS_REVIEW', 'claude:m,gemini:g')).toThrow(/AGENTS_REVIEW.*"gemini".*gemini:g/);
  });

  it('names the agent with an empty model or no model', () => {
    expect(() => parseAgentList('AGENTS_PLAN', 'claude: ')).toThrow(/AGENTS_PLAN.*empty model.*claude:/);
    expect(() => parseAgentList('AGENTS_PLAN', 'claude')).toThrow(/empty model/);
  });

  it('refuses an empty list', () => {
    expect(() => parseAgentList('AGENTS_PLAN', '')).toThrow(/AGENTS_PLAN/);
  });
});

describe('the role of a step', () => {
  it('covers every step and every reviewer', () => {
    for (const step of STEPS) {
      expect(Object.keys(ROLE_OF_STEP)).toContain(step);
    }
    for (const name of CODE_REVIEWERS) {
      expect(ROLE_OF_STEP[`code-review-${name}`]).toBe('review');
    }
    expect(ROLE_OF_STEP['code-review-report']).toBe('review');
  });

  it('gives plan, implement and review their steps, and the steps that run no agent none', () => {
    const roles = (role: string): string[] =>
      Object.keys(ROLE_OF_STEP).filter((step) => ROLE_OF_STEP[step as never] === role);
    expect(roles('plan')).toEqual(['research', 'plan', 'plan-improve', 'merge-request']);
    expect(roles('implement')).toEqual(['implement', 'implement-improve', 'chat', 'shell', 'rebase']);
    expect(roles('review')).toContain('code-review');
    expect(roles('review')).toHaveLength(7);
    for (const step of NO_AGENT) {
      expect(agentFor(testEnv(), null, step)).toBeNull();
    }
  });
});

describe('agentFor', () => {
  it('gives today’s runtime and models when only RUNTIME and MODEL_* are set', () => {
    const env = testEnv({ RUNTIME: 'claude', MODEL_PLAN: 'plan-m', MODEL_IMPLEMENT: 'impl-m' });
    const planned = ['research', 'plan', 'plan-improve', 'merge-request', 'code-review', 'code-review-report'];
    const built = ['implement', 'implement-improve', 'chat', 'shell', 'rebase'];
    for (const step of [...planned, ...CODE_REVIEWERS.map((name) => `code-review-${name}`)]) {
      expect(agentFor(env, null, step)).toEqual({ runtime: 'claude', model: 'plan-m' });
    }
    for (const step of built) {
      expect(agentFor(env, null, step)).toEqual({ runtime: 'claude', model: 'impl-m' });
    }
  });

  it('uses the first agent of a role and sends review to another runtime than implement', () => {
    const env = testEnv({
      AGENTS_IMPLEMENT: 'codex:gpt-6.1-sol,claude:fallback',
      AGENTS_REVIEW: 'claude:claude-opus-5-5',
    });
    expect(agentFor(env, null, 'implement')).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol' });
    expect(agentFor(env, null, 'code-review-security')).toEqual({ runtime: 'claude', model: 'claude-opus-5-5' });
    expect(agentFor(env, null, 'plan')).toEqual({ runtime: 'cursor', model: 'grok-4.7-high' });
  });

  it('gives a run with a parent the subtask tier, and the main role where the tier is unset', () => {
    const env = testEnv({
      AGENTS_IMPLEMENT: 'codex:main-impl',
      AGENTS_SUBTASK_IMPLEMENT: 'claude:sub-impl',
      AGENTS_PLAN: 'claude:main-plan',
    });
    const child = { parentRunId: 'parent-1' };
    expect(agentFor(env, child, 'implement')).toEqual({ runtime: 'claude', model: 'sub-impl' });
    expect(agentFor(env, child, 'plan')).toEqual({ runtime: 'claude', model: 'main-plan' });
    expect(agentFor(env, child, 'code-review')).toEqual({ runtime: 'cursor', model: 'grok-4.7-high' });
    expect(agentFor(env, {}, 'implement')).toEqual({ runtime: 'codex', model: 'main-impl' });
    expect(roleOf(child, 'implement')).toEqual({ role: 'implement', tier: 'subtask' });
    expect(roleOf({ parentRunId: null }, 'code-review-quality')).toEqual({ role: 'review', tier: 'main' });
    expect(roleOf(null, 'commit')).toBeNull();
  });
});

describe('the runtimes in use and the start-up check', () => {
  it('lists every runtime of every role and tier once', () => {
    expect(runtimesInUse(testEnv())).toEqual(['cursor']);
    const env = testEnv({ AGENTS_REVIEW: 'claude:m,codex:n', AGENTS_SUBTASK_PLAN: 'codex:p' });
    expect(runtimesInUse(env)).toEqual(['cursor', 'claude', 'codex']);
  });

  it('passes when every runtime has a credential', () => {
    expect(() => assertAgents({ ...testEnv({ AGENTS_REVIEW: 'claude:m' }), ...KEYS })).not.toThrow();
  });

  it('names the agent whose runtime has no credential', () => {
    const env = { ...testEnv({ AGENTS_REVIEW: 'claude:claude-opus-5-5' }), ...KEYS, ANTHROPIC_API_KEY: '' };
    expect(() => assertAgents(env)).toThrow(/claude:claude-opus-5-5 of review.*ANTHROPIC_API_KEY/);
  });

  it('refuses an unknown runtime and an empty model', () => {
    expect(() => assertAgents({ ...testEnv({ AGENTS_PLAN: 'gemini:g' }), ...KEYS })).toThrow(/AGENTS_PLAN.*gemini/);
    expect(() => assertAgents({ ...testEnv({ AGENTS_SUBTASK_REVIEW: 'cursor:' }), ...KEYS })).toThrow(
      /AGENTS_SUBTASK_REVIEW.*empty model/,
    );
  });
});
