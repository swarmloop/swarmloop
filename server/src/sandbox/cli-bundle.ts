import { SwarmloopError } from '../core/swarmloop-error';
import { CLI_ROOT } from '../sandbox/sandbox-launch';
import type { DockerRunner } from './sandbox.service';

/** Every agent image keeps its whole CLI under CLI_ROOT, which is where a project image gets it mounted. */
export const CLI_BIN = `${CLI_ROOT}/bin`;
const COMPLETE = '.complete';
const PREFIX = 'swarmloop-cli-';
const COPY_TIMEOUT_MS = 5 * 60_000;

/** One volume per agent image id: a rebuilt image gets a new volume, so a running container keeps its own. */
export function cliVolumeName(runtime: string, imageId: string): string {
  const id = imageId.replace(/^sha256:/, '').slice(0, 12);
  if (!/^[a-z]+$/.test(runtime) || !/^[0-9a-f]{12}$/.test(id)) {
    throw new SwarmloopError(`cli volume name is not valid for ${runtime}`);
  }
  return `${PREFIX}${runtime}-${id}`;
}

/** Copies `/opt/swarmloop` out of an agent image into a volume, once, and returns the volume name. */
export class CliBundles {
  private readonly ready = new Map<string, Promise<string>>();

  constructor(private readonly docker: DockerRunner) {}

  ensure(runtime: string, image: string): Promise<string> {
    const key = `${runtime}\0${image}`;
    let found = this.ready.get(key);
    if (!found) {
      found = this.build(runtime, image).catch((error: unknown) => {
        this.ready.delete(key);
        throw error;
      });
      this.ready.set(key, found);
    }
    return found;
  }

  private async build(runtime: string, image: string): Promise<string> {
    let imageId: string;
    try {
      imageId = (await this.docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
    } catch {
      throw new SwarmloopError(`sandbox image ${image} is missing: run docker/sandbox/build.sh`);
    }
    const volume = cliVolumeName(runtime, imageId);
    const mount = `type=volume,src=${volume},dst=/out`;
    const run = (script: string) =>
      this.docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          '0:0',
          '--mount',
          mount,
          '--entrypoint',
          'sh',
          image,
          '-c',
          script,
        ],
        COPY_TIMEOUT_MS,
      );
    await this.docker(['volume', 'create', volume]);
    const complete = (await run(`test -f /out/${COMPLETE} && echo yes || echo no`)).trim() === 'yes';
    if (!complete) {
      await run(
        `[ -n "$(ls -A ${CLI_BIN} 2>/dev/null)" ] || { echo "${image} has no ${CLI_BIN}" >&2; exit 2; }; ` +
          `rm -rf /out/* /out/.[!.]* 2>/dev/null; cp -a ${CLI_ROOT}/. /out/ && touch /out/${COMPLETE}`,
      );
    }
    await this.removeOld(runtime, volume);
    return volume;
  }

  /** Older volumes of the same runtime. One still mounted by a running container stays; the next call retries. */
  private async removeOld(runtime: string, keep: string): Promise<void> {
    let names: string[] = [];
    try {
      names = (await this.docker(['volume', 'ls', '-q', '--filter', `name=${PREFIX}${runtime}-`]))
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => name.startsWith(`${PREFIX}${runtime}-`) && name !== keep);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        await this.docker(['volume', 'rm', name]);
      } catch {
        continue;
      }
    }
  }
}
