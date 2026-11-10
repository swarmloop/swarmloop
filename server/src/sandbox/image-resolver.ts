import { rawEnv } from '../config/process-env';
import { ERROR_CODES } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';

type ImageComponent = `agent-${RuntimeName}` | 'egress';

/**
 * The one place that names a sandbox image. compose.yml sets SWARMLOOP_REGISTRY, so the server runs the release
 * image that compose pulled: `<registry>/swarmloop-<component>:<SWARMLOOP_VERSION, else latest>`. Without a
 * registry it is the local name that compose.build.yml and docker/sandbox/build.sh build.
 */
export function imageName(component: ImageComponent, env: NodeJS.ProcessEnv = rawEnv()): string {
  const registry = env.SWARMLOOP_REGISTRY;
  return registry
    ? `${registry}/swarmloop-${component}:${env.SWARMLOOP_VERSION || 'latest'}`
    : `swarmloop-${component}`;
}

/** What a run says when a sandbox image is not on the host. The run blocks; a person fixes it and resumes. */
export function imageMissing(name: string): SwarmloopError {
  return new SwarmloopError(
    `image ${name} is missing: \`docker compose up -d\` pulls it, docker/sandbox/build.sh builds it`,
    {
      code: ERROR_CODES.IMAGE_MISSING,
      category: 'environment',
    },
  );
}
