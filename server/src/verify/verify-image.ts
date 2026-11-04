import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { SwarmloopError } from '../core/swarmloop-error';
import { rawEnv } from '../config/process-env';
import { gitDetail } from '../git/git';
import type { DockerRunner } from '../sandbox/sandbox.service';
import type { SwarmloopManifest } from './manifest';
import { MANIFEST_DIR } from './manifest';

const run = promisify(execFile);

/** A pull or a build takes longer than the 30 s that quick docker calls get. */
const IMAGE_TIMEOUT_MS = 15 * 60_000;
const KEEP_TAGS = 3;

export interface VerifyImageInput {
  docker: DockerRunner;
  repoPath: string;
  baseRef: string;
  project: string;
  manifest: SwarmloopManifest;
}

/** The project name as a docker repository and directory name. */
export function projectSlug(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

/** The image the verify containers run. Built or pulled only when it is not already local. */
export async function resolveVerifyImage(input: VerifyImageInput): Promise<string> {
  const { image } = input.manifest;
  if (image) {
    await ensureImage(input.docker, image);
    return image;
  }
  return buildImage(input, input.manifest.dockerfile ?? '');
}

async function ensureImage(docker: DockerRunner, image: string): Promise<void> {
  if (await isLocal(docker, image)) {
    return;
  }
  try {
    await docker(['pull', image], IMAGE_TIMEOUT_MS);
  } catch (error) {
    throw new SwarmloopError(`image ${image} cannot be pulled: ${errorText(error)}`);
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

async function buildImage(input: VerifyImageInput, dockerfile: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-verify-image-'));
  try {
    await exportDirectory(input.repoPath, input.baseRef, dir);
    const context = join(dir, MANIFEST_DIR);
    const repository = `swarmloop-verify-${projectSlug(input.project)}`;
    const tag = `${repository}:${hashDirectory(context).slice(0, 12)}`;
    if (await isLocal(input.docker, tag)) {
      return tag;
    }
    if (!existsSync(join(dir, dockerfile))) {
      throw new SwarmloopError(`${dockerfile} is missing on ${input.baseRef}`);
    }
    try {
      await input.docker(['build', '-t', tag, '-f', join(dir, dockerfile), context], IMAGE_TIMEOUT_MS);
    } catch (error) {
      throw new SwarmloopError(`image build failed: ${errorText(error)}`);
    }
    await removeOldTags(input.docker, repository, tag);
    return tag;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Unpacks .swarmloop/ of the base ref. The worktree is never read. */
async function exportDirectory(repoPath: string, baseRef: string, dir: string): Promise<void> {
  const archive = join(dir, 'export.tar');
  try {
    await run('git', ['-C', repoPath, 'archive', '--format=tar', '-o', archive, baseRef, MANIFEST_DIR], {
      env: rawEnv(),
    });
  } catch (error) {
    throw new SwarmloopError(`${MANIFEST_DIR}/ is missing on ${baseRef}: ${gitDetail(error)}`);
  }
  await run('tar', ['-xf', archive, '-C', dir]);
}

/** sha256 over the name and bytes of every file, in sorted order. */
function hashDirectory(directory: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
  for (const name of files) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(join(directory, name)));
  }
  return hash.digest('hex');
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
