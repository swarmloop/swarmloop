import { posix } from 'path';
import Joi from 'joi';
import { SwarmloopError } from '../core/swarmloop-error';
import { git, gitDetail } from '../git/git';

export const MANIFEST_FILE = '.swarmloop.json';
export const MANIFEST_DIR = '.swarmloop';
export const CACHE_ROOT = '/home/sandbox/';

export interface SwarmloopManifest {
  version: 1;
  image?: string;
  dockerfile?: string;
  install?: string;
  verify: string[];
  cache?: string[];
  timeoutMin: number;
}

export interface ReadManifest {
  manifest: SwarmloopManifest;
  warnings: string[];
}

/** An absolute, normalized container path below /home/sandbox/. */
export function isCachePath(path: string): boolean {
  return path.startsWith(CACHE_ROOT) && !path.endsWith('/') && posix.normalize(path) === path;
}

const dockerfilePath = Joi.string().custom((value: string, helpers) => {
  const inside = value.startsWith(`${MANIFEST_DIR}/`) && posix.normalize(value) === value;
  return inside ? value : helpers.message({ custom: `"dockerfile" must be a path under ${MANIFEST_DIR}/` });
});

const cachePath = Joi.string().custom((value: string, helpers) =>
  isCachePath(value) ? value : helpers.message({ custom: `"cache" must hold absolute paths under ${CACHE_ROOT}` }),
);

const keys = {
  version: Joi.number().valid(1).required(),
  image: Joi.string().min(1),
  dockerfile: dockerfilePath,
  install: Joi.string().min(1),
  verify: Joi.array().items(Joi.string().min(1)).min(1).required(),
  cache: Joi.array().items(cachePath),
  timeoutMin: Joi.number().integer().min(1).max(60).default(15),
};

const schema = Joi.object<SwarmloopManifest>(keys).xor('image', 'dockerfile').unknown(true);

/** Reads the manifest from the base ref, never from the worktree. Null when the ref has none. */
export async function readManifest(repoPath: string, baseRef: string): Promise<ReadManifest | null> {
  let listed: string;
  try {
    listed = await git(['-C', repoPath, 'ls-tree', '--name-only', baseRef, '--', MANIFEST_FILE]);
  } catch (error) {
    throw new SwarmloopError(`${MANIFEST_FILE}: cannot read ${baseRef}: ${gitDetail(error)}`);
  }
  if (listed === '') {
    return null;
  }
  const text = await git(['-C', repoPath, 'show', `${baseRef}:${MANIFEST_FILE}`]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SwarmloopError(`${MANIFEST_FILE}: is not valid JSON`);
  }
  const { value, error } = schema.validate(raw, { abortEarly: false });
  if (error) {
    throw new SwarmloopError(`${MANIFEST_FILE}: ${error.details.map((detail) => detail.message).join('; ')}`);
  }
  const warnings = Object.keys(value as object)
    .filter((key) => !(key in keys))
    .map((key) => `unknown key "${key}" ignored`);
  return { manifest: value, warnings };
}
