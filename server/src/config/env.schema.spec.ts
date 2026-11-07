import 'reflect-metadata';
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
  MODEL_RESEARCH: 'grok-4.7-high',
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

  it('provides the validated env through AppConfig', async () => {
    const config = await compileWith(complete);
    expect(config.env).toMatchObject({
      RUNTIME: 'cursor',
      MAX_AGENT_CALLS: 50,
      MODEL_PLAN: 'grok-4.7-high',
      SWARMLOOP_API_PORT: 3920,
    });
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
