import { runActivity } from '../core/step-event-scope';
import type { RunEntity } from '../history/entities';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { imageOf, resolveImage, type RunImages } from '../sandbox/image-resolver';
import type { SandboxService } from '../sandbox/sandbox.service';

/** The document kind that holds the images a run started with. */
export const IMAGES = 'images';

interface Documents {
  latestBody(key: string, kind: string): Promise<string | null>;
  putDocument(run: RunEntity, kind: string, body: string): Promise<void>;
}

/** What the run started with, or null before its first preparation. */
export async function storedImages(documents: Pick<Documents, 'latestBody'>, key: string): Promise<RunImages | null> {
  const body = await documents.latestBody(key, IMAGES);
  return body ? (JSON.parse(body) as RunImages) : null;
}

/**
 * Makes the images of a run ready and keeps the references it started with. The first call resolves them, pulls
 * what is missing and stores them; later calls use the stored references, so a newer release never reaches a
 * running run. It is not an attempt: no counter of the run moves. Without a release manifest the local names stay
 * as they are, nothing is stored, and undefined comes back.
 */
export async function prepareRunImages(
  sandbox: Pick<SandboxService, 'images' | 'imagesOf' | 'startedWith'>,
  documents: Documents,
  run: RunEntity,
): Promise<RunImages | undefined> {
  const stored = await storedImages(documents, run.key);
  const wanted = stored
    ? { agent: imageOf(stored.agent.ref), egress: imageOf(stored.egress.ref) }
    : { agent: resolveImage(runtimeFor(run.runtime).component), egress: resolveImage('egress') };
  if (!stored && !wanted.agent.registry && !wanted.egress.registry) {
    return undefined;
  }
  const known = sandbox.imagesOf(run.key);
  if (known) {
    return known;
  }
  const prepare = async (): Promise<RunImages> => {
    const images = {
      agent: await sandbox.images.prepare(wanted.agent),
      egress: await sandbox.images.prepare(wanted.egress),
    };
    sandbox.startedWith(run.key, images);
    return images;
  };
  if (stored) {
    return prepare();
  }
  const images = await runActivity('environment.prepare', prepare, () => 'images ready');
  await documents.putDocument(run, IMAGES, JSON.stringify(images));
  return images;
}
