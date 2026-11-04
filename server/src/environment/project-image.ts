import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { SwarmloopError } from '../core/swarmloop-error';
import { rawEnv } from '../config/process-env';
import { git, gitDetail } from '../git/git';
import type { DockerRunner } from '../sandbox/sandbox.service';
import type { EnvironmentConfig } from './environment-config';

const run = promisify(execFile);
/** A pull or a build takes longer than the 30 s that quick docker calls get. */
const IMAGE_TIMEOUT_MS = 20 * 60_000;
const KEEP_TAGS = 3;
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function projectSlug(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

export function imageRepository(project: string): string {
  return `swarmloop-env-${projectSlug(project)}`;
}

/** The image the agent works in: pulled once, or built from the committed Dockerfile and reused until it changes. */
export async function resolveProjectImage(
  docker: DockerRunner,
  repoPath: string,
  project: string,
  config: EnvironmentConfig,
): Promise<string> {
  if (config.image) {
    if (!(await isLocal(docker, config.image))) {
      try {
        await docker(['pull', config.image], IMAGE_TIMEOUT_MS);
      } catch (error) {
        throw new SwarmloopError(`image ${config.image} cannot be pulled: ${errorText(error)}`);
      }
    }
    return config.image;
  }
  const dockerfile = config.dockerfile ?? '';
  const context = config.context ?? '.';
  const repository = imageRepository(project);
  const tag = `${repository}:${(await contentId(repoPath, dockerfile, context)).slice(0, 12)}`;
  if (await isLocal(docker, tag)) {
    return tag;
  }
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-env-image-'));
  try {
    const archive = join(dir, 'export.tar');
    const paths = context === '.' ? ['.'] : [context, dockerfile];
    await run('git', ['-C', repoPath, 'archive', '--format=tar', '-o', archive, 'HEAD', ...paths], { env: rawEnv() });
    await run('tar', ['-xf', archive, '-C', dir]);
    try {
      await docker(['build', '-t', tag, '-f', join(dir, dockerfile), join(dir, context)], IMAGE_TIMEOUT_MS);
    } catch (error) {
      throw new SwarmloopError(`image build from ${dockerfile} failed: ${errorText(error)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await removeOldTags(docker, repository, tag);
  return tag;
}

/** Git already hashes content: the tree of the build context and the blob of the Dockerfile name the image exactly. */
async function contentId(repoPath: string, dockerfile: string, context: string): Promise<string> {
  const read = async (spec: string): Promise<string> => {
    try {
      return (await git(['-C', repoPath, 'rev-parse', '--verify', '--quiet', spec])).trim();
    } catch (error) {
      throw new SwarmloopError(
        `${spec.slice('HEAD:'.length) || 'the repository'} is not committed: ${gitDetail(error)}`,
      );
    }
  };
  const tree = await read(context === '.' ? 'HEAD^{tree}' : `HEAD:${context}`);
  const file = await read(`HEAD:${dockerfile}`);
  return createHash('sha256').update(`${tree}\0${dockerfile}\0${file}`).digest('hex');
}

/** PATH as the image sets it, so its own tools stay where the image put them. */
export async function imagePath(docker: DockerRunner, image: string): Promise<string> {
  try {
    const raw = await docker(['image', 'inspect', '--format', '{{json .Config.Env}}', image]);
    const env = JSON.parse(raw.trim() || '[]') as unknown;
    const found = Array.isArray(env)
      ? env.find((item): item is string => typeof item === 'string' && item.startsWith('PATH='))
      : undefined;
    const path = found?.slice('PATH='.length) ?? '';
    return /^[A-Za-z0-9_./:-]+$/.test(path) ? path : DEFAULT_PATH;
  } catch {
    return DEFAULT_PATH;
  }
}

async function isLocal(docker: DockerRunner, image: string): Promise<boolean> {
  try {
    await docker(['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the newest tags, the one just built first. Failures are ignored. */
async function removeOldTags(docker: DockerRunner, repository: string, current: string): Promise<void> {
  try {
    const listed = await docker([
      'image',
      'ls',
      '--filter',
      `reference=${repository}:*`,
      '--format',
      '{{.Repository}}:{{.Tag}}',
    ]);
    const tags = listed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== current);
    for (const tag of tags.slice(KEEP_TAGS - 1)) {
      await docker(['rmi', tag]).catch(() => undefined);
    }
  } catch {
    return;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
