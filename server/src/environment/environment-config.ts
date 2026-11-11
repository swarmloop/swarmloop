import { posix } from 'path';
import Joi from 'joi';
import { SwarmloopError } from '../core/swarmloop-error';
import { git, gitDetail, originUrl } from '../git/git';
import { hostRefusal, remoteHost } from '../sandbox/sandbox-launch';

const SWARMLOOP_FILE = '.swarmloop.json';
const SWARMLOOP_DIR = '.swarmloop';
const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];
const CACHE_ROOT = '/home/sandbox/';

/** Where the agent's toolchain comes from: the image, one setup command, caches, and the checks it must run. */
export interface EnvironmentConfig {
  source: string;
  image?: string;
  /** Repository-relative Dockerfile and the directory it builds in. */
  dockerfile?: string;
  context?: string;
  setup?: string;
  cache: string[];
  checks: string[];
  /** `registries`: the agent may install packages itself. `setup`: only setup reaches the registries. */
  network?: AgentNetwork;
  /** Hosts the project needs besides the built-in registries: for its setup, and for the agent. */
  hosts?: ProjectHosts;
}

export interface ProjectHosts {
  setup?: string[];
  agent?: string[];
}

export type AgentNetwork = 'registries' | 'setup';
const NETWORKS: AgentNetwork[] = ['registries', 'setup'];

function isCachePath(path: string): boolean {
  return path.startsWith(CACHE_ROOT) && !path.endsWith('/') && posix.normalize(path) === path;
}

const cachePath = Joi.string().custom((value: string, helpers) =>
  isCachePath(value) ? value : helpers.message({ custom: `"cache" must hold absolute paths under ${CACHE_ROOT}` }),
);

const dockerfilePath = Joi.string().custom((value: string, helpers) =>
  value.startsWith(`${SWARMLOOP_DIR}/`) && posix.normalize(value) === value
    ? value
    : helpers.message({ custom: `"dockerfile" must be a path under ${SWARMLOOP_DIR}/` }),
);

/** Keys of the first format. Unknown keys are allowed, so without this they would be dropped without a word. */
const RENAMED: Record<string, string> = { install: 'setup', verify: 'checks' };

/** Entries are checked against the ceiling by `checkHosts`, which gives each one its reason, so the schema only types them. */
const hostsSchema = Joi.object({
  setup: Joi.array().items(Joi.string().allow('')),
  agent: Joi.array().items(Joi.string().allow('')),
}).unknown(true);

const swarmloopSchema = Joi.object({
  version: Joi.number().valid(1).required(),
  image: Joi.string().min(1),
  dockerfile: dockerfilePath,
  setup: Joi.string().min(1),
  checks: Joi.array().items(Joi.string().min(1)),
  cache: Joi.array().items(cachePath),
  network: Joi.string().valid(...NETWORKS),
  hosts: hostsSchema,
})
  .xor('image', 'dockerfile')
  .unknown(true);

/** Reads a committed revision, so worktree edits cannot redefine the environment. */
export async function readEnvironmentConfig(repoPath: string, ref = 'HEAD'): Promise<EnvironmentConfig | null> {
  const own = await committedFile(repoPath, SWARMLOOP_FILE, ref);
  if (own !== null) {
    return withCeiling(repoPath, fromSwarmloop(own));
  }
  for (const file of DEVCONTAINER_FILES) {
    const text = await committedFile(repoPath, file, ref);
    if (text !== null) {
      return withCeiling(repoPath, fromDevcontainer(text, file));
    }
  }
  return null;
}

/** The hosts of the checkout's remotes, or none. Empty when there is no origin. */
export async function originHosts(repoPath: string): Promise<string[]> {
  const url = await originUrl(repoPath, repoPath, 'origin failed');
  return url ? [remoteHost(url)] : [];
}

/**
 * The ceiling needs the origin host, so it is read only when the manifest names hosts: any other manifest costs no git
 * call. A refused host stops the run, one error for the entries of a manifest.
 */
async function withCeiling(repoPath: string, config: EnvironmentConfig): Promise<EnvironmentConfig> {
  if (config.hosts) {
    checkHosts(config, await originHosts(repoPath));
  }
  return config;
}

/** Every host of the manifest must pass the ceiling of `sandbox-launch.ts`. Throws one error naming each refused entry. */
function checkHosts(config: EnvironmentConfig, origins: readonly string[]): void {
  const refused = (['setup', 'agent'] as const).flatMap((kind) =>
    (config.hosts?.[kind] ?? []).flatMap((host) => {
      const reason = hostRefusal(host, kind, origins);
      return reason ? [`${config.source}: hosts.${kind}: ${host} ${reason}`] : [];
    }),
  );
  if (refused.length > 0) {
    throw new SwarmloopError(refused.join('; '));
  }
}

async function committedFile(repoPath: string, path: string, ref: string): Promise<string | null> {
  let listed: string;
  try {
    listed = await git(['-C', repoPath, 'ls-tree', '--name-only', ref, '--', path]);
  } catch (error) {
    throw new SwarmloopError(`Cannot read project environment at ${ref}: ${gitDetail(error)}`);
  }
  if (listed.trim() === '') {
    return null;
  }
  return git(['-C', repoPath, 'show', `${ref}:${path}`]);
}

export function fromSwarmloop(text: string): EnvironmentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SwarmloopError(`${SWARMLOOP_FILE}: is not valid JSON`);
  }
  const renamed = Object.entries(RENAMED)
    .filter(([old]) => typeof raw === 'object' && raw !== null && old in raw)
    .map(([old, now]) => `"${old}" is now "${now}"`);
  if (renamed.length > 0) {
    throw new SwarmloopError(`${SWARMLOOP_FILE}: ${renamed.join(', ')}`);
  }
  const checked = swarmloopSchema.validate(raw, { abortEarly: false });
  if (checked.error) {
    throw new SwarmloopError(`${SWARMLOOP_FILE}: ${checked.error.details.map((detail) => detail.message).join('; ')}`);
  }
  const value = checked.value as {
    image?: string;
    dockerfile?: string;
    setup?: string;
    checks?: string[];
    cache?: string[];
    network?: AgentNetwork;
    hosts?: ProjectHosts;
  };
  const hosts = projectHosts(value.hosts, value.network, (message) => {
    throw new SwarmloopError(`${SWARMLOOP_FILE}: ${message}`);
  });
  const checks = value.checks ?? [];
  return {
    source: SWARMLOOP_FILE,
    ...(value.image ? { image: value.image } : {}),
    ...(value.dockerfile ? { dockerfile: value.dockerfile, context: SWARMLOOP_DIR } : {}),
    ...(value.setup ? { setup: value.setup } : {}),
    cache: value.cache ?? [],
    checks,
    ...(value.network ? { network: value.network } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

/** The part of devcontainer.json swarmloop understands: image or build, the create commands, and its own customizations. */
export function fromDevcontainer(text: string, file: string): EnvironmentConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  } catch {
    throw new SwarmloopError(`${file}: is not valid JSON`);
  }
  const fail = (message: string): never => {
    throw new SwarmloopError(`${file}: ${message}`);
  };
  if (raw.features && typeof raw.features === 'object' && Object.keys(raw.features).length > 0) {
    fail('"features" are not supported yet; install those tools in the Dockerfile or use an image that has them');
  }
  if (raw.dockerComposeFile !== undefined) {
    fail('"dockerComposeFile" is not supported; use "image" or "build"');
  }
  const base = posix.dirname(file);
  const build = (raw.build ?? {}) as Record<string, unknown>;
  const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : raw.dockerFile;
  let image: string | undefined;
  let dockerfilePath: string | undefined;
  let context: string | undefined;
  if (typeof dockerfile === 'string' && dockerfile !== '') {
    dockerfilePath = inside(posix.join(base, dockerfile), fail);
    const relative = typeof build.context === 'string' ? build.context : ((raw.context as string | undefined) ?? '.');
    context = inside(posix.join(base, relative), fail);
  } else if (typeof raw.image === 'string' && raw.image !== '') {
    image = raw.image;
  } else {
    fail('give "image" or "build.dockerfile"');
  }
  const own = ((raw.customizations as Record<string, unknown> | undefined)?.swarmloop ?? {}) as Record<string, unknown>;
  const network = NETWORKS.find((item) => item === own.network);
  const checkedHosts = own.hosts === undefined ? undefined : hostsSchema.validate(own.hosts);
  if (checkedHosts?.error) {
    fail(`hosts: ${checkedHosts.error.details.map((detail) => detail.message).join('; ')}`);
  }
  const hosts = projectHosts(checkedHosts?.value as ProjectHosts | undefined, network, fail);
  const setup = [raw.onCreateCommand, raw.updateContentCommand, raw.postCreateCommand]
    .map(lifecycleCommand)
    .filter((command) => command !== '')
    .join(' && ');
  return {
    source: file,
    ...(image ? { image } : {}),
    ...(dockerfilePath ? { dockerfile: dockerfilePath, context } : {}),
    ...(setup ? { setup } : {}),
    cache: strings(own.cache).filter(isCachePath),
    checks: strings(own.checks),
    ...(NETWORKS.includes(own.network as AgentNetwork) ? { network: own.network as AgentNetwork } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

/** The `hosts` key of a manifest, or undefined when it names none. The agent's hosts need the agent to have the registries. */
function projectHosts(
  hosts: ProjectHosts | undefined,
  network: AgentNetwork | undefined,
  fail: (message: string) => never,
): ProjectHosts | undefined {
  const setup = hosts?.setup ?? [];
  const agent = hosts?.agent ?? [];
  if (agent.length > 0 && network === 'setup') {
    fail('hosts.agent: is not allowed with "network": "setup"');
  }
  if (setup.length === 0 && agent.length === 0) {
    return undefined;
  }
  return { ...(setup.length > 0 ? { setup } : {}), ...(agent.length > 0 ? { agent } : {}) };
}

function inside(path: string, fail: (message: string) => never): string {
  const normal = posix.normalize(path);
  if (normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal)) {
    return fail(`${path} is outside the repository`);
  }
  return normal;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/** A lifecycle command is a shell string, an argv array, or an object of named commands that may run in parallel. */
export function lifecycleCommand(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => shellQuote(String(item))).join(' ');
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(lifecycleCommand)
      .filter((command) => command !== '')
      .map((command) => `(${command})`)
      .join(' && ');
  }
  return '';
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** devcontainer.json is JSON with comments and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    const next = text[at + 1] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        at += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (at < text.length && text[at] !== '\n') {
        at += 1;
      }
      out += '\n';
    } else if (char === '/' && next === '*') {
      at = text.indexOf('*/', at + 2);
      at = at === -1 ? text.length : at + 1;
    } else {
      out += char;
    }
  }
  return withoutTrailingCommas(out);
}

function withoutTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[at + 1] ?? '';
        at += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === ',' && /^\s*[}\]]/.test(text.slice(at + 1))) {
      continue;
    }
    out += char;
  }
  return out;
}
