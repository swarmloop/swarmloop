import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from './config.module';
import { AppConfig, optionalLimit } from './env';
import { envSchema } from './env.schema';

/** Compiles the config module from a temp .env file and returns the injected AppConfig. */
async function compileWith(values: Record<string, string | number>): Promise<AppConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'swarmloop-env-'));
  const path = join(dir, '.env');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await writeFile(path, lines.join('\n'));
  try {
    const moduleRef = await Test.createTestingModule({ imports: [SwarmloopConfigModule.forRoot(path)] }).compile();
    return moduleRef.get(AppConfig);
  } finally {
    for (const key of Object.keys(values)) {
      delete process.env[key];
    }
  }
}

const complete = {
  RUNTIME: 'cursor',
  REQUIREMENTS_VIA: 'agent',
  ISSUE_TRACKER: 'jira',
  JIRA_BASE_URL: '',
  JIRA_EMAIL: '',
  JIRA_API_TOKEN: '',
  GITLAB_BASE_URL: '',
  GITLAB_TOKEN: '',
  GITHUB_BASE_URL: '',
  GITHUB_TOKEN: '',
  CURSOR_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  MAX_AGENT_CALLS: 50,
  MAX_RETURNS: 3,
  MAX_PIPELINE_RETURNS: 6,
  MAX_LAUNCHES: 3,
  STOP_GRACE_S: 10,
  RECONCILE_MS: 60_000,
  RECOVER_WAIT_MS: 600_000,
  MAX_RUN_USD: 50,
  IDLE_TIMEOUT_MS: 900_000,
  TICK_MS: 15_000,
  REQUIREMENTS_TIMEOUT_MS: 600_000,
  RESEARCH_TIMEOUT_MS: 900_000,
  PLAN_TIMEOUT_MS: 1_200_000,
  IMPLEMENT_TIMEOUT_MS: 1_800_000,
  CODE_REVIEW_TIMEOUT_MS: 900_000,
  MERGE_REQUEST_TIMEOUT_MS: 600_000,
  PIPELINE_TIMEOUT_MS: 1_800_000,
  PIPELINE_START_TIMEOUT_MS: 180_000,
  MODEL_PLAN: 'grok-4.7-high',
  MODEL_IMPLEMENT: 'grok-4.7-high',
  SWARMLOOP_API_PORT: 3920,
  SWARMLOOP_API_HOST: '127.0.0.1',
};

describe('env schema', () => {
  it('treats a blank spend cap as unlimited and zero as a cap', () => {
    expect(optionalLimit('')).toBeNull();
    expect(optionalLimit(undefined)).toBeNull();
    expect(optionalLimit(0)).toBe(0);
    expect(optionalLimit('25')).toBe(25);
  });

  it('names a missing variable', () => {
    const { error } = envSchema.validate({ ...complete, RUNTIME: undefined }, { abortEarly: false, convert: true });
    expect(error?.message).toContain('RUNTIME');
    expect(error?.message).toContain('missing');
  });

  it('names an unknown provider value', () => {
    const { error } = envSchema.validate(
      { ...complete, ISSUE_TRACKER: 'github' },
      { abortEarly: false, convert: true },
    );
    expect(error?.message).toContain('ISSUE_TRACKER');
    expect(error?.message).toContain('github');
  });

  it('keeps the values from the file and names a missing limit', () => {
    const { error, value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(error).toBeUndefined();
    expect(value.MAX_AGENT_CALLS).toBe(50);
    expect(value.MAX_PIPELINE_RETURNS).toBe(6);
    expect(value.MODEL_PLAN).toBe('grok-4.7-high');
    const missing = envSchema.validate(
      { ...complete, MAX_AGENT_CALLS: undefined },
      { abortEarly: false, convert: true },
    );
    expect(missing.error?.message).toContain('MAX_AGENT_CALLS');
    expect(missing.error?.message).toContain('missing');
  });

  it('keeps a bare env valid and names a bad SWARMLOOP_ALLOW entry', () => {
    const bare = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(bare.error).toBeUndefined();
    expect(bare.value).toMatchObject({
      SWARMLOOP_ALLOW: '',
      SWARMLOOP_TOKEN: '',
      SWARMLOOP_SECRET: '',
      GITHUB_OAUTH_CLIENT_ID: '',
    });
    const good = envSchema.validate({ ...complete, SWARMLOOP_ALLOW: 'github:Ann, gitlab-group:team/dev' });
    expect(good.error).toBeUndefined();
    const bad = envSchema.validate({ ...complete, SWARMLOOP_ALLOW: 'github:ann,twitter:bob' }, { convert: true });
    expect(bad.error?.message).toContain('twitter:bob');
  });

  it('defaults the retention, disk and docker settings and rejects a negative retention', () => {
    const { value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(value).toMatchObject({ RETAIN_DONE_DAYS: 3, MIN_FREE_GB: 10, DOCKER_PRUNE: true });
    const off = envSchema.validate({ ...complete, DOCKER_PRUNE: 'false' }, { convert: true });
    expect(off.value.DOCKER_PRUNE).toBe(false);
    const bad = envSchema.validate({ ...complete, RETAIN_DONE_DAYS: -1 }, { convert: true });
    expect(bad.error?.message).toContain('RETAIN_DONE_DAYS');
  });

  it('defaults the parallel check commands to 3 and rejects zero', () => {
    const { value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(value.CHECKS_PARALLEL).toBe(3);
    const bad = envSchema.validate({ ...complete, CHECKS_PARALLEL: 0 }, { convert: true });
    expect(bad.error?.message).toContain('CHECKS_PARALLEL');
  });

  it('defaults the provider limit cooldown to 60 minutes and rejects zero', () => {
    const { value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(value.LIMIT_COOLDOWN_MIN).toBe(60);
    const bad = envSchema.validate({ ...complete, LIMIT_COOLDOWN_MIN: 0 }, { convert: true });
    expect(bad.error?.message).toContain('LIMIT_COOLDOWN_MIN');
  });

  it('defaults LOOP_REPEAT to 4 and rejects zero', () => {
    const { value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(value.LOOP_REPEAT).toBe(4);
    const bad = envSchema.validate({ ...complete, LOOP_REPEAT: 0 }, { convert: true });
    expect(bad.error?.message).toContain('LOOP_REPEAT');
  });

  it('provides the validated env through AppConfig', async () => {
    const config = await compileWith(complete);
    expect(config.env).toMatchObject({
      RUNTIME: 'cursor',
      MAX_AGENT_CALLS: 50,
      MODEL_PLAN: 'grok-4.7-high',
      SWARMLOOP_API_PORT: 3920,
    });
  });

  it('defaults the public URL and reads SWARMLOOP_REPOS as a trimmed list', async () => {
    const config = await compileWith(complete);
    expect(config.env.SWARMLOOP_PUBLIC_URL).toBe('http://127.0.0.1:3921');
    expect(config.env.SWARMLOOP_REPOS).toEqual([]);
    const narrowed = await compileWith({ ...complete, SWARMLOOP_REPOS: ' api, web ,,' });
    expect(narrowed.env.SWARMLOOP_REPOS).toEqual(['api', 'web']);
  });

  it('reads an empty token limit as no cap', async () => {
    const config = await compileWith({ ...complete, MAX_RUN_TOKENS: '' });
    expect(config.env.MAX_RUN_TOKENS).toBeNull();
  });

  it('accepts codex with both keys empty', () => {
    const { error, value } = envSchema.validate(
      { ...complete, RUNTIME: 'codex' },
      { abortEarly: false, convert: true },
    );
    expect(error).toBeUndefined();
    expect(value.CODEX_AUTH).toBe('');
    expect(value.CODEX_API_KEY).toBe('');
  });

  it('reads the agent roles and leaves them empty by default', async () => {
    const plain = await compileWith(complete);
    expect(plain.env).toMatchObject({
      AGENTS_PLAN: '',
      AGENTS_IMPLEMENT: '',
      AGENTS_REVIEW: '',
      AGENTS_SUBTASK_REVIEW: '',
    });
    const listed = await compileWith({
      ...complete,
      AGENTS_PLAN: 'claude:opus, codex:gpt',
      AGENTS_SUBTASK_IMPLEMENT: 'cursor:grok-4.7-high',
    });
    expect(listed.env.AGENTS_PLAN).toBe('claude:opus, codex:gpt');
    expect(listed.env.AGENTS_SUBTASK_IMPLEMENT).toBe('cursor:grok-4.7-high');
  });

  it('still loads an old file with MODEL_RESEARCH and warns that it was never read', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await compileWith(complete);
      expect(warn).not.toHaveBeenCalled();
      const config = await compileWith({ ...complete, MODEL_RESEARCH: 'grok-4.7-high' });
      expect(config.env.MODEL_PLAN).toBe('grok-4.7-high');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MODEL_RESEARCH is set but was never read'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps JIRA_PROJECTS optional and empty by default', async () => {
    const config = await compileWith(complete);
    expect(config.env.JIRA_PROJECTS).toBe('');
  });

  it('keeps the defaults for values the file leaves out', async () => {
    const { MAX_PIPELINE_RETURNS: _omitted, ...withoutDefaults } = complete;
    const config = await compileWith(withoutDefaults);
    expect(config.env.MAX_PIPELINE_RETURNS).toBe(6);
    expect(config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  it('fails bootstrap when a variable is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarmloop-env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'REQUIREMENTS_VIA=agent\nISSUE_TRACKER=jira\n');
    await expect(
      Test.createTestingModule({ imports: [SwarmloopConfigModule.forRoot(path)] }).compile(),
    ).rejects.toThrow(/RUNTIME/);
  });
});

describe('split settings', () => {
  it('SPLIT defaults to off and SPLIT_MAX_TASKS to 12', () => {
    const { error, value } = envSchema.validate(complete, { abortEarly: false, convert: true });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ SPLIT: 'auto', SPLIT_MAX_TASKS: 12 });
  });

  it('rejects a SPLIT value other than auto or off', () => {
    expect(envSchema.validate({ ...complete, SPLIT: 'auto' }, { convert: true }).value.SPLIT).toBe('auto');
    const bad = envSchema.validate({ ...complete, SPLIT: 'on' }, { convert: true });
    expect(bad.error?.message).toContain('SPLIT');
  });

  it('SUBTASKS_PARALLEL defaults to 3 and takes a whole number from 1', () => {
    expect(envSchema.validate(complete, { convert: true }).value.SUBTASKS_PARALLEL).toBe(3);
    expect(envSchema.validate({ ...complete, SUBTASKS_PARALLEL: '5' }, { convert: true }).value.SUBTASKS_PARALLEL).toBe(
      5,
    );
    expect(envSchema.validate({ ...complete, SUBTASKS_PARALLEL: '0' }, { convert: true }).error?.message).toContain(
      'SUBTASKS_PARALLEL',
    );
  });
});
