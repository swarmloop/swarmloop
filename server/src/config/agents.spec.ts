import { readFileSync } from 'fs';
import { join } from 'path';
import { CODE_REVIEWERS, STEPS } from '../contract/steps';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { testEnv } from './env.spec-helpers';
import { shippedDefaults, validateSettings } from './env.schema.spec-helpers';
import {
  agentFor,
  agentsFor,
  assertAgents,
  firstAvailable,
  backlogPlanAgents,
  backlogReadAgents,
  helperFor,
  knownModels,
  namedAgentsFor,
  namedBacklogPlanAgents,
  parseAgent,
  parseAgentList,
  ROLE_OF_STEP,
  roleOf,
  runAgents,
  runtimesInUse,
  runtimesNamingEffort,
} from './agents';

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
    expect(roles('plan')).toEqual(['research', 'plan', 'plan-improve', 'merge-request', 'backlog-plan']);
    expect(roles('implement')).toEqual(['implement', 'implement-improve', 'rebase']);
    expect(roles('review')).toContain('code-review');
    expect(roles('review')).toHaveLength(7);
    for (const step of NO_AGENT) {
      expect(agentFor(testEnv(), null, step)).toBeNull();
    }
  });
});

describe('agentFor', () => {
  it('the three main lists set and the subtask lists empty: a subtask uses the main lists', () => {
    const env = testEnv({
      AGENTS_PLAN: 'claude:plan-m',
      AGENTS_IMPLEMENT: 'claude:impl-m',
      AGENTS_REVIEW: 'claude:plan-m',
    });
    const child = { parentRunId: 1 };
    const planned = ['research', 'plan', 'plan-improve', 'merge-request', 'code-review', 'code-review-report'];
    const built = ['implement', 'implement-improve', 'rebase'];
    for (const step of [...planned, ...CODE_REVIEWERS.map((name) => `code-review-${name}`)]) {
      expect(agentFor(env, null, step)).toEqual({ runtime: 'claude', model: 'plan-m', effort: 'high' });
      expect(agentFor(env, child, step)).toEqual({ runtime: 'claude', model: 'plan-m', effort: 'medium' });
    }
    for (const step of built) {
      expect(agentFor(env, null, step)).toEqual({ runtime: 'claude', model: 'impl-m', effort: 'high' });
      expect(agentFor(env, child, step)).toEqual({ runtime: 'claude', model: 'impl-m', effort: 'medium' });
    }
  });

  it('with AGENTS_IMPLEMENT=codex:gpt-6.1-sol implement and subtask implement use Codex', () => {
    const env = testEnv({ AGENTS_IMPLEMENT: 'codex:gpt-6.1-sol' });
    expect(agentFor(env, null, 'implement')).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(agentFor(env, { parentRunId: 1 }, 'implement')).toEqual({
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
    });
  });

  it('uses the first agent of a role and sends review to another runtime than implement', () => {
    const env = testEnv({
      AGENTS_IMPLEMENT: 'codex:gpt-6.1-sol,claude:fallback',
      AGENTS_REVIEW: 'claude:claude-opus-5-5',
    });
    expect(agentFor(env, null, 'implement')).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(agentFor(env, null, 'code-review-security')).toEqual({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(agentFor(env, null, 'plan')).toEqual({ runtime: 'cursor', model: 'grok-4.7-high' });
  });

  it('gives a run with a parent the subtask tier, and the main role where the tier is unset', () => {
    const env = testEnv({
      AGENTS_IMPLEMENT: 'codex:main-impl',
      AGENTS_SUBTASK_IMPLEMENT: 'claude:sub-impl',
      AGENTS_PLAN: 'claude:main-plan',
    });
    const child = { parentRunId: 1 };
    expect(agentFor(env, child, 'implement')).toEqual({ runtime: 'claude', model: 'sub-impl', effort: 'medium' });
    expect(agentFor(env, child, 'plan')).toEqual({ runtime: 'claude', model: 'main-plan', effort: 'medium' });
    expect(agentFor(env, child, 'code-review')).toEqual({ runtime: 'cursor', model: 'grok-4.7-high' });
    expect(agentFor(env, {}, 'implement')).toEqual({ runtime: 'codex', model: 'main-impl', effort: 'high' });
    expect(roleOf(child, 'implement')).toEqual({ role: 'implement', tier: 'subtask' });
    expect(roleOf({ parentRunId: null }, 'code-review-quality')).toEqual({ role: 'review', tier: 'main' });
    expect(roleOf(null, 'commit')).toBeNull();
  });
});

describe('agentFor with a stored choice', () => {
  const env = testEnv({ AGENTS_PLAN: 'cursor:env-plan', AGENTS_SUBTASK_PLAN: 'cursor:env-sub-plan' });
  const agents = {
    main: {
      plan: [
        { runtime: 'claude', model: 'mine' },
        { runtime: 'codex', model: 'next' },
      ],
    },
    subtask: { plan: [{ runtime: 'codex', model: 'sub-mine' }] },
  };

  it('uses the stored list before env and keeps its order', () => {
    expect(agentFor(env, { agents }, 'plan')).toEqual({ runtime: 'claude', model: 'mine', effort: 'high' });
    expect(agentsFor(env, { agents }, 'plan').map((agent) => agent.model)).toEqual(['mine', 'next']);
  });

  it('never feeds the main list to a subtask, which uses its own tier', () => {
    expect(agentFor(env, { parentRunId: 3, agents: { main: agents.main } }, 'plan')).toEqual({
      runtime: 'cursor',
      model: 'env-sub-plan',
    });
    expect(agentFor(env, { parentRunId: 3, agents }, 'plan')).toEqual({
      runtime: 'codex',
      model: 'sub-mine',
      effort: 'medium',
    });
  });

  it('uses env for a role the choice does not name, and when there is no choice', () => {
    expect(agentFor(env, { agents }, 'implement')).toEqual(agentFor(env, null, 'implement'));
    expect(agentFor(env, { agents: null }, 'plan')).toEqual({ runtime: 'cursor', model: 'env-plan' });
  });

  it('skips a stored runtime that is no longer known', () => {
    const stale = { main: { plan: [{ runtime: 'gemini', model: 'g' }] } };
    expect(agentFor(env, { agents: stale }, 'plan')).toEqual({ runtime: 'cursor', model: 'env-plan' });
  });
});

describe('firstAvailable', () => {
  const env = testEnv({
    AGENTS_REVIEW: 'claude:review-m,codex:gpt-6.1-sol,cursor:grok-4.7-high',
    AGENTS_SUBTASK_REVIEW: 'cursor:sub-review',
  });

  it('is the first agent when nothing cools down, so the first agent returns after a cooldown', () => {
    expect(firstAvailable(agentsFor(env, null, 'code-review-quality'), new Set())).toEqual({
      runtime: 'claude',
      model: 'review-m',
      effort: 'high',
    });
  });

  it('skips the cooling runtimes in the order of the role', () => {
    expect(firstAvailable(agentsFor(env, null, 'code-review'), new Set(['claude']))).toEqual({
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
    });
    expect(firstAvailable(agentsFor(env, null, 'code-review'), new Set(['claude', 'codex']))).toEqual({
      runtime: 'cursor',
      model: 'grok-4.7-high',
    });
  });

  it('is null when every agent of the role cools down, and for a step without an agent', () => {
    expect(firstAvailable(agentsFor(env, null, 'code-review'), new Set(['claude', 'codex', 'cursor']))).toBeNull();
    expect(firstAvailable(agentsFor(env, null, 'commit'), new Set())).toBeNull();
    expect(agentsFor(env, null, 'commit')).toEqual([]);
  });

  it('keeps to the tier of the run', () => {
    expect(firstAvailable(agentsFor(env, { parentRunId: 4 }, 'code-review'), new Set(['claude']))).toEqual({
      runtime: 'cursor',
      model: 'sub-review',
    });
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
    expect(() => assertAgents(env)).not.toThrow();
  });

  it('passes a list that names a level while its runtime list is not loaded', () => {
    expect(() => assertAgents({ ...testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high' }), ...KEYS })).not.toThrow();
  });

  it('refuses an unknown runtime and an empty model', () => {
    expect(() => assertAgents({ ...testEnv({ AGENTS_PLAN: 'gemini:g' }), ...KEYS })).toThrow(/AGENTS_PLAN.*gemini/);
    expect(() => assertAgents({ ...testEnv({ AGENTS_SUBTASK_REVIEW: 'cursor:' }), ...KEYS })).toThrow(
      /AGENTS_SUBTASK_REVIEW.*empty model/,
    );
  });
});

describe('the readers that need no model list', () => {
  const env = testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high,claude:m:low', AGENTS_SUBTASK_REVIEW: 'codex:n:medium' });
  const stored = { agents: { main: { plan: [{ runtime: 'cursor', model: 'grok-4.7', effort: 'high' }] } } };

  it('read the runtimes and models of agents that name a level while the list is not loaded', () => {
    expect(runtimeFor('cursor').listLoaded()).toBe(false);
    expect(runtimesInUse(env)).toEqual(['cursor', 'claude', 'codex']);
    expect(knownModels(env)).toEqual({ cursor: ['grok-4.7', 'grok-4.7-high'], claude: ['m'], codex: ['n'] });
    expect(namedAgentsFor(env, null, 'plan')).toEqual([
      { runtime: 'cursor', model: 'grok-4.7', effort: 'high' },
      { runtime: 'claude', model: 'm', effort: 'low' },
    ]);
    expect(runAgents(env, stored).map((agent) => agent.runtime)).toContain('cursor');
  });

  it('give the stored choice of a run before env, and drop a stored runtime that is unknown', () => {
    const agents = { main: { plan: [{ runtime: 'gemini', model: 'g' }, ...stored.agents.main.plan] } };
    expect(namedAgentsFor(env, { agents }, 'plan')).toEqual([{ runtime: 'cursor', model: 'grok-4.7', effort: 'high' }]);
  });

  it('leave a launch strict: its level still needs the list', () => {
    expect(() => agentFor(env, null, 'plan')).toThrow(/model list of cursor is not loaded/);
  });
});

describe('the models env knows', () => {
  it('lists the models of the main lists under their runtime', () => {
    const env = testEnv({ AGENTS_PLAN: 'claude:p', AGENTS_IMPLEMENT: 'claude:i', AGENTS_REVIEW: 'claude:p' });
    expect(knownModels(env)).toEqual({ claude: ['p', 'i'] });
  });

  it('adds the role lists in order, with no duplicates, and gives only the list models', () => {
    const env = testEnv({
      AGENTS_PLAN: 'claude:a,codex:b,claude:a',
      AGENTS_SUBTASK_REVIEW: 'claude:c',
    });
    expect(knownModels(env)).toEqual({ claude: ['a', 'c'], codex: ['b'], cursor: ['grok-4.7-high'] });
  });
});

describe('agents with an effort', () => {
  const recorded = readFileSync(
    join(__dirname, '../integrations/agent-runtime/cursor/cursor-models.recorded.txt'),
    'utf8',
  );
  beforeEach(() => runtimeFor('cursor').useModelList(recorded));
  afterEach(() => runtimeFor('cursor').useModelList(''));

  const epicRun = { epicAt: '2026-11-13T10:00:00Z' };
  const claudeEnv = (extra: Record<string, string> = {}) =>
    testEnv({ AGENTS_PLAN: 'claude:claude-opus-5-5:high', EPIC_EFFORT: 'xhigh', ...extra });

  it('parses the effort after the model, and none without it', () => {
    expect(parseAgent('AGENTS_PLAN', 'claude:claude-opus-5-5:high')).toEqual({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(parseAgent('AGENTS_PLAN', 'claude:claude-opus-5-5')).toEqual({
      runtime: 'claude',
      model: 'claude-opus-5-5',
    });
  });

  it('keeps a Cursor id that carries its own level as the model', () => {
    expect(parseAgent('AGENTS_PLAN', 'cursor:grok-4.7-high')).toEqual({ runtime: 'cursor', model: 'grok-4.7-high' });
    expect(agentFor(testEnv({ AGENTS_PLAN: 'cursor:grok-4.7-high' }), null, 'plan')).toEqual({
      runtime: 'cursor',
      model: 'grok-4.7-high',
    });
  });

  it('keeps the model of a Cursor agent and its level apart', () => {
    expect(agentFor(testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high' }), null, 'plan')).toEqual({
      runtime: 'cursor',
      model: 'grok-4.7',
      effort: 'high',
    });
  });

  it('refuses a level the runtime does not declare, naming the agent and the role', () => {
    expect(() => parseAgent('AGENTS_REVIEW', 'cursor:some-model:xhigh')).toThrow(
      /AGENTS_REVIEW.*cursor:some-model:xhigh/,
    );
    expect(() => parseAgent('AGENTS_PLAN', 'codex:gpt-6.1-sol:max')).toThrow(/AGENTS_PLAN.*codex:gpt-6.1-sol:max/);
    expect(() => assertAgents({ ...testEnv({ AGENTS_PLAN: 'codex:gpt-6.1-sol:max' }), ...KEYS })).toThrow(
      /codex:gpt-6.1-sol:max/,
    );
  });

  it('drops a stored level its runtime no longer declares and keeps the model', () => {
    const agents = { main: { plan: [{ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'max' }] } };
    expect(agentFor(claudeEnv(), { agents }, 'plan')).toEqual({
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
    });
  });

  it('raises the parent of a split run to EPIC_EFFORT and says so', () => {
    expect(agentFor(claudeEnv(), epicRun, 'plan')).toEqual({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      effortNote: 'epic',
    });
  });

  it('raises only the plan role of an epic parent; implement and review keep their own effort', () => {
    const env = claudeEnv({
      AGENTS_IMPLEMENT: 'claude:claude-sonnet-5-5:high',
      AGENTS_REVIEW: 'claude:claude-sonnet-5-5:high',
    });
    for (const step of ['plan-improve', 'merge-request'] as const) {
      expect(agentFor(env, epicRun, step)).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
    }
    const kept = ['implement', 'rebase', 'code-review', 'code-review-report', 'code-review-quality'] as const;
    for (const step of kept) {
      expect(agentFor(env, epicRun, step)).toEqual({ runtime: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    }
  });

  it('never lowers an agent that is above EPIC_EFFORT', () => {
    const env = claudeEnv({ AGENTS_PLAN: 'claude:claude-opus-5-5:max' });
    expect(agentFor(env, epicRun, 'plan')).toEqual({ runtime: 'claude', model: 'claude-opus-5-5', effort: 'max' });
  });

  it('holds the level to the highest the runtime declares and says so', () => {
    const env = claudeEnv({ AGENTS_PLAN: 'codex:gpt-6.1-sol:high', EPIC_EFFORT: 'max' });
    expect(agentFor(env, epicRun, 'plan')).toMatchObject({
      runtime: 'codex',
      effort: 'xhigh',
      effortNote: 'capped:max',
    });
  });

  it('changes nothing when EPIC_EFFORT is empty or the run is not split', () => {
    expect(agentFor(claudeEnv({ EPIC_EFFORT: '' }), epicRun, 'plan').effort).toBe('high');
    expect(agentFor(claudeEnv(), {}, 'plan').effort).toBe('high');
  });

  it("gives a subtask its tier's agents and efforts, never raised", () => {
    const env = claudeEnv({ AGENTS_SUBTASK_PLAN: 'claude:sub:low' });
    expect(agentFor(env, { parentRunId: 2, ...epicRun }, 'plan')).toEqual({
      runtime: 'claude',
      model: 'sub',
      effort: 'low',
    });
    expect(agentFor(claudeEnv({ AGENTS_SUBTASK_PLAN: 'claude:sub' }), { parentRunId: 2 }, 'plan')).toEqual({
      runtime: 'claude',
      model: 'sub',
      effort: 'medium',
    });
  });

  it('resolves the effort of the next agent when a limit moves the work', () => {
    const env = claudeEnv({ AGENTS_PLAN: 'claude:a:high,codex:b:high' });
    expect(firstAvailable(agentsFor(env, epicRun, 'plan-improve'), new Set(['claude']))).toEqual({
      runtime: 'codex',
      model: 'b',
      effort: 'xhigh',
      effortNote: 'epic',
    });
  });

  it('runs an entry without an effort at the level of the entry before it, capped to what its runtime offers', () => {
    const after = (own: string) =>
      agentsFor(testEnv({ AGENTS_PLAN: `claude:claude-opus-5-5:${own},codex:gpt-6.1-sol` }), null, 'plan')[1];
    expect(after('high')).toMatchObject({ runtime: 'codex', effort: 'high' });
    expect(after('max')).toMatchObject({ runtime: 'codex', effort: 'xhigh', effortNote: 'capped:max' });
  });

  it('runs a first entry without an effort at the defaults.env level of its role and tier', () => {
    const env = testEnv({ AGENTS_IMPLEMENT: 'claude:a', AGENTS_SUBTASK_REVIEW: 'claude:b' });
    expect(agentFor(env, null, 'implement').effort).toBe('high');
    expect(agentFor(env, { parentRunId: 1 }, 'code-review').effort).toBe('medium');
  });

  it('raises the plan of an epic parent whose first entry has no effort', () => {
    const env = testEnv({ AGENTS_PLAN: 'claude:claude-opus-5-5', EPIC_EFFORT: 'xhigh' });
    expect(agentFor(env, epicRun, 'plan')).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
  });

  it('names every runtime the env lists name, since each entry runs at a level', () => {
    expect(runtimesNamingEffort(testEnv({ AGENTS_PLAN: 'claude:m:high', AGENTS_REVIEW: 'cursor:grok-4.7' }))).toEqual([
      'claude',
      'cursor',
    ]);
  });
});

describe('a level that needs a model list that is not loaded', () => {
  it('is refused with what to do, from env and from a stored run', () => {
    expect(() => parseAgent('AGENTS_PLAN', 'cursor:grok-4.7:high')).toThrow(
      /model list of cursor is not loaded.*start/,
    );
    const stored = { main: { plan: [{ runtime: 'cursor', model: 'grok-4.7', effort: 'high' }] } };
    expect(() => agentFor(testEnv(), { agents: stored }, 'plan')).toThrow(/model list of cursor is not loaded/);
  });
});

describe('the shipped defaults', () => {
  it("parses every shipped agent list and runs subtasks at medium, main roles and an epic parent's planning at high", () => {
    const { error, value } = validateSettings({}, { convert: true });
    expect(error).toBeUndefined();
    assertAgents({ ...value, ...KEYS });
    const defaults = shippedDefaults();
    for (const name of Object.keys(defaults).filter(
      (key) => /^AGENTS_(SUBTASK_)?(PLAN|IMPLEMENT|REVIEW)$/.test(key) && defaults[key] !== '',
    )) {
      expect(() => parseAgentList(name, value[name])).not.toThrow();
    }
    const env = value as ReturnType<typeof testEnv>;
    const efforts = (run: object) =>
      ['plan', 'implement', 'code-review'].map((step) => agentFor(env, run, step)?.effort);
    expect(efforts({ parentRunId: 2 })).toEqual(['medium', 'medium', 'medium']);
    expect(efforts({})).toEqual(['high', 'high', 'high']);
    expect(efforts({ epicAt: '2026-11-13T10:00:00Z' })).toEqual(['high', 'high', 'high']);
    expect(agentFor(env, { epicAt: '2026-11-13T10:00:00Z' }, 'plan-improve')?.effort).toBe('high');
  });
});

describe('the backlog tier', () => {
  const env = testEnv({
    AGENTS_PLAN: 'cursor:main-plan',
    AGENTS_SUBTASK_PLAN: 'cursor:sub-plan',
    AGENTS_BACKLOG_PLAN: 'claude:backlog-a,codex:backlog-b',
  });

  it('has its own list, with the fallback order', () => {
    expect(backlogPlanAgents(env)).toEqual([
      { runtime: 'claude', model: 'backlog-a', effort: 'high' },
      { runtime: 'codex', model: 'backlog-b', effort: 'high' },
    ]);
  });

  it('gives a stored choice before env', () => {
    const stored = { backlog: { plan: [{ runtime: 'codex', model: 'mine' }] } };
    expect(backlogPlanAgents(env, stored)).toEqual([{ runtime: 'codex', model: 'mine', effort: 'high' }]);
  });

  it('falls back to the main plan role when its list is empty', () => {
    const empty = testEnv({ AGENTS_PLAN: 'cursor:main-plan', AGENTS_BACKLOG_PLAN: '' });
    expect(backlogPlanAgents(empty)).toEqual([{ runtime: 'cursor', model: 'main-plan' }]);
    expect(namedBacklogPlanAgents(empty)).toEqual([{ runtime: 'cursor', model: 'main-plan' }]);
  });

  it('resolves the effort and caps it to the runtime levels', () => {
    const high = testEnv({ AGENTS_BACKLOG_PLAN: 'claude:claude-opus-5-5:xhigh' });
    expect(backlogPlanAgents(high)[0]).toMatchObject({ runtime: 'claude', model: 'claude-opus-5-5' });
    const capped = backlogPlanAgents(testEnv({ AGENTS_BACKLOG_PLAN: 'claude:claude-sonnet-5-5:max' }))[0];
    expect(capped.effort).toBeDefined();
  });

  it('is listed by the readers of every list, and by the start-up check', () => {
    expect(runtimesInUse(env)).toEqual(['cursor', 'claude', 'codex']);
    expect(knownModels(env)).toMatchObject({ claude: ['backlog-a'], codex: ['backlog-b'] });
    expect(runtimesNamingEffort(testEnv({ AGENTS_BACKLOG_PLAN: 'claude:m:high' }))).toEqual(['cursor', 'claude']);
    expect(() => assertAgents({ ...testEnv({ AGENTS_BACKLOG_PLAN: 'gemini:g' }), ...KEYS })).toThrow(
      /AGENTS_BACKLOG_PLAN.*gemini/,
    );
  });

  it('leaves the agents of a run as they were', () => {
    expect(agentFor(env, null, 'plan')).toEqual({ runtime: 'cursor', model: 'main-plan' });
    expect(agentsFor(env, { parentRunId: 1 }, 'plan')).toEqual([{ runtime: 'cursor', model: 'sub-plan' }]);
    expect(runAgents(env, null).map((agent) => agent.model)).not.toContain('backlog-a');
  });
});

describe('the backlog helpers', () => {
  it('parses like every list, with its level resolved', () => {
    const env = testEnv({ AGENTS_BACKLOG_READ: 'claude:a:high,codex:b' });
    const [first, second] = backlogReadAgents(env);
    expect(first).toEqual({ runtime: 'claude', model: 'a', effort: 'high' });
    expect(second).toEqual({ runtime: 'codex', model: 'b', effort: 'high' });
  });

  it('resolves a level against what its runtime declares for the model, as for every list', () => {
    const offered = {
      claude: ['low', 'medium', 'high', 'xhigh', 'max'],
      codex: ['low', 'medium', 'high', 'xhigh'],
    } as const;
    const spies = (['claude', 'codex'] as const).map((name) =>
      jest.spyOn(runtimeFor(name), 'efforts').mockReturnValue(offered[name]),
    );
    try {
      const [first, second] = backlogReadAgents(testEnv({ AGENTS_BACKLOG_READ: 'claude:a:max,codex:b' }));
      expect(first).toEqual({ runtime: 'claude', model: 'a', effort: 'max' });
      expect(second).toEqual({ runtime: 'codex', model: 'b', effort: 'xhigh', effortNote: 'capped:max' });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('runs a helper at the level before it, and a first one at its own list level, never the plan role', () => {
    const plan = { AGENTS_PLAN: 'claude:claude-opus-5-5:xhigh' };
    const [first] = backlogReadAgents(testEnv({ ...plan, AGENTS_BACKLOG_READ: 'claude:claude-sonnet-5-5' }));
    expect(first.effort).toBe('medium');
    const list = 'claude:claude-opus-5-5:high,claude:claude-sonnet-5-5';
    expect(backlogReadAgents(testEnv({ ...plan, AGENTS_BACKLOG_READ: list }))[1].effort).toBe('high');
  });

  it('gives no helper for an empty list and passes the start-up check', () => {
    const env = testEnv({ AGENTS_BACKLOG_READ: '' });
    expect(backlogReadAgents(env)).toEqual([]);
    expect(() => assertAgents({ ...env, ...KEYS })).not.toThrow();
  });

  it('refuses an unknown runtime at start-up, naming the setting', () => {
    expect(() => assertAgents({ ...testEnv({ AGENTS_BACKLOG_READ: 'gemini:g' }), ...KEYS })).toThrow(
      /AGENTS_BACKLOG_READ.*gemini/,
    );
  });

  it('names a runtime whose helper has a level, and leaves readiness and models alone', () => {
    const env = testEnv({ AGENTS_BACKLOG_READ: 'claude:m:high' });
    expect(runtimesNamingEffort(env)).toEqual(['cursor', 'claude']);
    expect(runtimesInUse(env)).not.toContain('claude');
    expect(knownModels(env).claude ?? []).not.toContain('m');
  });

  it('picks the first entry of the runtime, and none for a runtime without an entry or without helpers', () => {
    const helpers = backlogReadAgents(testEnv({ AGENTS_BACKLOG_READ: 'codex:x,claude:h1,claude:h2' }));
    expect(helperFor(helpers, 'claude')).toMatchObject({ model: 'h1' });
    expect(helperFor(helpers, 'cursor')).toBeUndefined();
    expect(helperFor(helpers, 'codex')).toBeUndefined();
    expect(helperFor(undefined, 'claude')).toBeUndefined();
  });
});
