import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { SwarmloopConfigModule } from './config.module';
import { AppConfig } from './env';
import { envSchema } from './env.schema';
import { shippedDefaults } from './env.schema.spec-helpers';
import {
  applySettings,
  assertSettings,
  envFilePath,
  parseEnvFile,
  readDefaultSettings,
  readSettings,
} from './load-env';
import { SettingSources } from './setting-sources';

describe('settings loading', () => {
  let root: string;
  let file: string;
  const saved = process.env;

  beforeEach(async () => {
    root = await mkdtemp(join(__dirname, '.load-spec-'));
    file = join(root, '.env');
    process.env = {};
  });

  afterEach(async () => {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  });

  it('loads exactly the shipped defaults without launch settings or an optional file', () => {
    const settings = readSettings(file, {});
    expect(settings.values).toEqual(shippedDefaults());
    expect(assertSettings(settings)).toBeNull();
    expect(Object.values(settings.sources).every((source) => source === 'default')).toBe(true);
  });

  it('has exact two-way schema/default-key parity and no duplicate defaults', () => {
    const lines = readFileSync(join(__dirname, '../../..', 'defaults.env'), 'utf8').split('\n');
    const keys = lines.filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split('=')[0]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(envSchema.describe().keys).sort());
  });

  it('uses the schema only for validation, without requirements or defaults', () => {
    const result = envSchema.validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({});
  });

  it('copies provenance so later changes to its input cannot change a setting source', () => {
    const input: Record<string, '.env' | 'environment'> = { MAX_RETURNS: '.env' };
    const sources = new SettingSources(input);
    input.MAX_RETURNS = 'environment';
    expect(sources.get('MAX_RETURNS')).toBe('.env');
  });

  it('parses export prefixes, spaces, surrounding quotes, empty values and equals signs', () => {
    expect(parseEnvFile(` # comment\nexport TOKEN = "a=b"\n SINGLE=' text '\nEMPTY=\nignored\n`)).toEqual({
      TOKEN: 'a=b',
      SINGLE: ' text ',
      EMPTY: '',
    });
  });

  it('propagates read errors other than an absent optional file', async () => {
    await mkdir(file);
    expect(() => readSettings(file, {})).toThrow();
  });

  it('lets the optional file override defaults and launch values override both, with accurate sources', async () => {
    await writeFile(file, 'MAX_RETURNS=7\nMAX_LAUNCHES=8\n');
    const settings = readSettings(file, { MAX_LAUNCHES: '11' });
    expect(settings.values.MAX_RETURNS).toBe('7');
    expect(settings.values.MAX_LAUNCHES).toBe('11');
    expect(settings.sources).toMatchObject({ MAX_RETURNS: '.env', MAX_LAUNCHES: 'environment', SPLIT: 'default' });
  });

  it('preserves explicit empty values at both precedence boundaries', async () => {
    await writeFile(file, 'EPIC_EFFORT=\nGITHUB_BASE_URL=from-file\n');
    const settings = readSettings(file, { GITHUB_BASE_URL: '' });
    expect(settings.values.EPIC_EFFORT).toBe('');
    expect(settings.values.GITHUB_BASE_URL).toBe('');
    expect(settings.sources.EPIC_EFFORT).toBe('.env');
    expect(settings.sources.GITHUB_BASE_URL).toBe('environment');
    expect(assertSettings(settings)).toBeNull();
  });

  it('replaces earlier file values and unknown compatibility keys without leaking into the launch snapshot', async () => {
    process.env = { MAX_RETURNS: '12', LAUNCH_ONLY: 'kept' };
    await writeFile(file, 'MAX_RETURNS=7\nMODEL_RESEARCH=old\nMAX_LAUNCHES=8\n');
    applySettings(readSettings(file));
    expect(process.env.MAX_RETURNS).toBe('12');
    expect(process.env.MODEL_RESEARCH).toBe('old');
    await writeFile(file, 'MAX_RETURNS=6\n');
    const second = readSettings(file);
    applySettings(second);
    expect(process.env.MODEL_RESEARCH).toBeUndefined();
    expect(process.env.MAX_LAUNCHES).toBe(shippedDefaults().MAX_LAUNCHES);
    expect(process.env.MAX_RETURNS).toBe('12');
    expect(process.env.LAUNCH_ONLY).toBe('kept');
    expect(second.sources.MAX_LAUNCHES).toBe('default');
    expect(second.sources.MAX_RETURNS).toBe('environment');
  });

  it('preserves launch values when applying settings read in isolation', () => {
    const target = { GITHUB_TOKEN: 'launch' };
    applySettings(readSettings(file, {}), target);
    expect(target.GITHUB_TOKEN).toBe('launch');
  });

  it('keeps a value the process changed after launch and leaves empty defaults unset', () => {
    const target: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '1' };
    applySettings(readSettings(file, target), target);
    target.GIT_CONFIG_COUNT = '4';
    applySettings(readSettings(file, target), target);
    expect(target.GIT_CONFIG_COUNT).toBe('4');
    expect(target).not.toHaveProperty('GIT_AUTHOR_NAME');
  });

  it('treats undefined launch entries as absent when reading and applying settings', () => {
    const launch: NodeJS.ProcessEnv = { MAX_RETURNS: undefined };
    const settings = readSettings(file, launch);
    expect(settings.values.MAX_RETURNS).toBe(shippedDefaults().MAX_RETURNS);
    applySettings(settings, launch);
    expect(launch.MAX_RETURNS).toBe(shippedDefaults().MAX_RETURNS);
  });

  it('selects a redirected optional file only from the launch environment', async () => {
    const redirected = join(root, 'other.env');
    await writeFile(redirected, 'MAX_RETURNS=17\n');
    expect(readSettings(envFilePath(root, { SWARMLOOP_ENV_FILE: redirected }), {}).values.MAX_RETURNS).toBe('17');
    expect(readSettings(undefined, { SWARMLOOP_ENV_FILE: redirected }).values.MAX_RETURNS).toBe('17');
    expect(envFilePath(root, { SWARMLOOP_ENV_FILE: '' })).toBe(file);
    process.env = {};
    await writeFile(file, `SWARMLOOP_ENV_FILE=${redirected}\nMAX_RETURNS=8\n`);
    applySettings(readSettings(envFilePath(root)));
    expect(envFilePath(root)).toBe(file);
    expect(readSettings(envFilePath(root)).values.MAX_RETURNS).toBe('8');
  });

  it('anchors defaults to the code root despite a configured root and redirected file', async () => {
    await writeFile(join(root, 'defaults.env'), 'MAX_RETURNS=999\n');
    const settings = readSettings(file, { SWARMLOOP_ROOT: root, SWARMLOOP_ENV_FILE: file });
    expect(settings.values.MAX_RETURNS).toBe(shippedDefaults().MAX_RETURNS);
    expect(readDefaultSettings()).toEqual(shippedDefaults());
  });

  it.each([
    ['MAX_RETURNS', 'bad'],
    ['CHECKS_PARALLEL', '0'],
    ['DOCKER_PRUNE', 'perhaps'],
    ['SANDBOX_EGRESS', 'unknown'],
    ['SANDBOX_DOCKER_RUNTIME', '../bad'],
    ['SWARMLOOP_ALLOW', 'unknown:person'],
    ['SWARMLOOP_UID', '-1'],
    ['SWARMLOOP_API_PORT', ''],
    ['MAX_RETURNS', ''],
    ['AGENTS_PLAN', ''],
    ['AGENTS_IMPLEMENT', ''],
    ['AGENTS_REVIEW', ''],
  ])('names an invalid %s value (%s)', (name, value) => {
    expect(assertSettings(readSettings(file, { [name]: value }))).toContain(name);
  });

  it('supplies missing main agents from the file and explains explicitly empty lists', () => {
    for (const name of ['AGENTS_PLAN', 'AGENTS_IMPLEMENT', 'AGENTS_REVIEW']) {
      expect(readSettings(file, {}).values[name]).toBe(shippedDefaults()[name]);
      expect(assertSettings(readSettings(file, { [name]: '' }))).toContain(
        `${name} is missing: set it as in defaults.env`,
      );
    }
  });

  it('retains raw image, UID, git, sandbox and host settings, including supported empty values', async () => {
    const raw = {
      SWARMLOOP_REGISTRY: 'registry.example/team',
      SWARMLOOP_VERSION: 'v1',
      SWARMLOOP_UID: '1234',
      GIT_AUTHOR_NAME: 'A Person',
      GIT_AUTHOR_EMAIL: 'person@example.com',
      SANDBOX_DOCKER_RUNTIME: 'runsc',
      SANDBOX_EGRESS: 'open',
      PROJECT_HOSTS_ALLOW: 'example.com',
    };
    await writeFile(
      file,
      Object.entries(raw)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    const settings = readSettings(file, {});
    expect(settings.values).toMatchObject(raw);
    expect(assertSettings(settings)).toBeNull();
    const empty = Object.fromEntries(
      Object.keys(raw)
        .filter((key) => key !== 'SANDBOX_EGRESS')
        .map((key) => [key, '']),
    );
    const cleared = readSettings(file, empty);
    expect(cleared.values).toMatchObject(empty);
    expect(assertSettings(cleared)).toBeNull();
  });

  it('keeps independent immutable provenance and values across module boots', async () => {
    await writeFile(file, 'MAX_RETURNS=7\n');
    const first = await Test.createTestingModule({ imports: [SwarmloopConfigModule.forRoot(file, {})] }).compile();
    try {
      const second = await Test.createTestingModule({
        imports: [SwarmloopConfigModule.forRoot(file, { MAX_RETURNS: '9' })],
      }).compile();
      try {
        const sources = first.get(SettingSources);
        expect(sources.get('MAX_RETURNS')).toBe('.env');
        expect(second.get(SettingSources).get('MAX_RETURNS')).toBe('environment');
        expect(Object.isFrozen(sources)).toBe(true);
        expect(first.get(AppConfig).env.MAX_RETURNS).toBe(7);
        expect(second.get(AppConfig).env.MAX_RETURNS).toBe(9);
        expect(process.env).toEqual({});
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});
