import { readFileSync } from 'fs';
import { rawEnv } from '../config/process-env';
import { SwarmloopError } from '../core/swarmloop-error';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';

type ImageComponent = `agent-${RuntimeName}` | 'egress';

export interface ResolvedImage {
  /** A registry reference (`repo@sha256:digest`) from the release manifest, or the local name `build.sh` tags. */
  ref: string;
  /** True for a reference that can be pulled. A local name has nothing to pull. */
  registry: boolean;
  /** The release version of the manifest the reference came from. */
  version?: string;
}

/** A reference counts as a registry reference when it is pinned by digest. */
export function imageOf(ref: string): ResolvedImage {
  return { ref, registry: ref.includes('@sha256:') };
}

/** The image a run started with. Later steps of the run use these, so a newer release does not change it. */
export interface RunImages {
  agent: { ref: string; id?: string };
  egress: { ref: string; id?: string };
}

/** The document kind that holds the images a run started with. */
export const IMAGES = 'images';

/** What the run started with, or null before its first preparation. */
export async function storedImages(
  documents: { latestBody(key: string, kind: string): Promise<string | null> },
  key: string,
): Promise<RunImages | null> {
  const body = await documents.latestBody(key, IMAGES);
  return body ? (JSON.parse(body) as RunImages) : null;
}

interface Manifest {
  version: string;
  images: Record<string, string>;
}

function readManifest(path: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SwarmloopError(
      `release manifest ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parsed as Partial<Manifest> | null;
  if (typeof manifest?.version !== 'string' || !manifest.images || typeof manifest.images !== 'object') {
    throw new SwarmloopError(`release manifest ${path} must be { version, images }`);
  }
  return manifest as Manifest;
}

/**
 * The one place that names an image. A release manifest (SWARMLOOP_RELEASE_MANIFEST) gives a registry reference;
 * without one the local name from docker/sandbox/build.sh is used. The manifest is read on every call, so a new
 * run sees a new release while a run that stored its images keeps the old one.
 */
export function resolveImage(
  component: ImageComponent,
  manifestPath = rawEnv().SWARMLOOP_RELEASE_MANIFEST,
): ResolvedImage {
  if (!manifestPath) {
    return { ref: `swarmloop-${component}`, registry: false };
  }
  const manifest = readManifest(manifestPath);
  const ref = manifest.images[component];
  if (typeof ref !== 'string' || ref === '') {
    throw new SwarmloopError(`release manifest ${manifestPath} has no image for ${component}`);
  }
  return { ...imageOf(ref), version: manifest.version };
}
