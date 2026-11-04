import { posix } from 'path';
import Joi from 'joi';
import { SwarmloopError } from '../core/swarmloop-error';
import { git } from '../git/git';

export const SWARMLOOP_FILE = '.swarmloop.json';
export const SWARMLOOP_DIR = '.swarmloop';
export const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];
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
}

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

const swarmloopSchema = Joi.object({
  version: Joi.number().valid(1).required(),
  image: Joi.string().min(1),
  dockerfile: dockerfilePath,
  setup: Joi.string().min(1),
  checks: Joi.array().items(Joi.string().min(1)),
  cache: Joi.array().items(cachePath),
})
  .xor('image', 'dockerfile')
  .unknown(true);

/** Reads the environment of a repository from its committed HEAD, so edits the agent makes do not change the run. */
export async function readEnvironmentConfig(repoPath: string): Promise<EnvironmentConfig | null> {
  const own = await committedFile(repoPath, SWARMLOOP_FILE);
  if (own !== null) {
    return fromSwarmloop(own);
  }
  for (const file of DEVCONTAINER_FILES) {
    const text = await committedFile(repoPath, file);
    if (text !== null) {
      return fromDevcontainer(text, file);
    }
  }
  return null;
}

async function committedFile(repoPath: string, path: string): Promise<string | null> {
  const listed = await git(['-C', repoPath, 'ls-tree', '--name-only', 'HEAD', '--', path]).catch(() => '');
  if (listed.trim() === '') {
    return null;
  }
  return git(['-C', repoPath, 'show', `HEAD:${path}`]);
}

export function fromSwarmloop(text: string): EnvironmentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SwarmloopError(`${SWARMLOOP_FILE}: is not valid JSON`);
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
  };
  const checks = value.checks ?? [];
  return {
    source: SWARMLOOP_FILE,
    ...(value.image ? { image: value.image } : {}),
    ...(value.dockerfile ? { dockerfile: value.dockerfile, context: SWARMLOOP_DIR } : {}),
    ...(value.setup ? { setup: value.setup } : {}),
    cache: value.cache ?? [],
    checks,
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
  };
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
