import { ERROR_CODES, type ErrorCode } from '../contract/error-codes';
import { startCommandSpan } from '../core/step-event-scope';
import { SwarmloopError } from '../core/swarmloop-error';
import type { ResolvedImage } from './image-resolver';

const VERSION_LABEL = 'org.opencontainers.image.version';
const PULL_TIMEOUT_MS = 10 * 60_000;
/** Waits before each retry of a pull that failed on the network. Three retries, then the failure stands. */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

type Docker = (args: string[], timeoutMs?: number) => Promise<string>;

interface PreparedImage {
  ref: string;
  /** Absent when a local image is missing: the code that needs it says so with today's text. */
  id?: string;
}

interface Options {
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Docker's own words for a failed pull, mapped to the reason that tells a person what to fix. */
function pullCode(text: string): ErrorCode {
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(text)) {
    return ERROR_CODES.DOCKER_UNAVAILABLE;
  }
  if (
    /unauthorized|authentication required|access denied|requested access to the resource is denied|\b40[13]\b/i.test(
      text,
    )
  ) {
    return ERROR_CODES.REGISTRY_AUTH;
  }
  if (/no matching manifest|does not provide the specified platform|exec format error/i.test(text)) {
    return ERROR_CODES.ARCH_UNSUPPORTED;
  }
  if (/manifest unknown|not found|\b404\b/i.test(text)) {
    return ERROR_CODES.IMAGE_MISSING;
  }
  return ERROR_CODES.REGISTRY_UNREACHABLE;
}

/** The docker architecture name of this host. */
function hostArchitecture(): string {
  return process.arch === 'x64' ? 'amd64' : process.arch;
}

/** A step of the preparation as the command the attempt shows. */
function span(executable: string, args: string[]): ReturnType<typeof startCommandSpan> {
  return startCommandSpan({ actor: 'server', repo: '', cwd: process.cwd(), executable, args });
}

function coded(message: string, code: ErrorCode): SwarmloopError {
  return new SwarmloopError(message, { code, category: 'environment' });
}

/**
 * Makes an image ready before a launch. A registry reference that is missing is pulled, once at a time per
 * reference, and checked against the host and the release. It never builds and never falls back to another version.
 */
export class ImagePreparation {
  private readonly pulling = new Map<string, Promise<PreparedImage>>();
  private readonly delays: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly docker: Docker,
    options: Options = {},
  ) {
    this.delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async dockerUp(): Promise<void> {
    try {
      await this.docker(['info']);
    } catch {
      throw coded('docker is not running', ERROR_CODES.DOCKER_UNAVAILABLE);
    }
  }

  /** Runs that wait for the same reference share one outcome. */
  prepare(image: ResolvedImage): Promise<PreparedImage> {
    let found = this.pulling.get(image.ref);
    if (!found) {
      found = this.ready(image).finally(() => this.pulling.delete(image.ref));
      this.pulling.set(image.ref, found);
    }
    return found;
  }

  private async ready(image: ResolvedImage): Promise<PreparedImage> {
    if (!image.registry) {
      const id = await this.inspectId(image.ref);
      return id ? { ref: image.ref, id } : { ref: image.ref };
    }
    await this.dockerUp();
    const present = await this.inspectId(image.ref);
    if (present) {
      return { ref: image.ref, id: present };
    }
    await this.pull(image.ref);
    const id = await this.inspectId(image.ref);
    if (!id) {
      throw coded(`image ${image.ref} is missing after the pull`, ERROR_CODES.IMAGE_MISSING);
    }
    await this.validate(image, id);
    return { ref: image.ref, id };
  }

  private async inspectId(ref: string): Promise<string | null> {
    try {
      return (await this.docker(['image', 'inspect', '--format', '{{.Id}}', ref])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Retries only what the network can fix. A refusal or a wrong platform would fail the same way again. */
  private async pull(ref: string): Promise<void> {
    for (let retry = 0; ; retry += 1) {
      const finish = span('docker', ['pull', ref]);
      try {
        finish({ exitCode: 0, output: await this.docker(['pull', ref], PULL_TIMEOUT_MS) });
        return;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        finish({ exitCode: 1, output: text });
        const code = pullCode(text);
        const delay = this.delays[retry];
        if (code !== ERROR_CODES.REGISTRY_UNREACHABLE || delay === undefined) {
          throw coded(`image ${ref} cannot be pulled: ${text}`, code);
        }
        await this.sleep(delay);
      }
    }
  }

  private async validate(image: ResolvedImage, id: string): Promise<void> {
    const finish = span('image validated', []);
    try {
      await this.check(image, id);
    } catch (error) {
      finish({ exitCode: 1, output: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    finish({ exitCode: 0 });
  }

  private async check(image: ResolvedImage, id: string): Promise<void> {
    const raw = await this.docker([
      'image',
      'inspect',
      '--format',
      '{{.Os}}/{{.Architecture}} {{json .Config.Labels}}',
      id,
    ]);
    const space = raw.indexOf(' ');
    const platform = raw.slice(0, space);
    const labels = (JSON.parse(raw.slice(space + 1).trim() || 'null') ?? {}) as Record<string, string>;
    if (platform !== `linux/${hostArchitecture()}`) {
      throw coded(
        `image ${image.ref} is built for ${platform}, this host runs linux/${hostArchitecture()}`,
        ERROR_CODES.ARCH_UNSUPPORTED,
      );
    }
    if (image.version !== undefined && labels[VERSION_LABEL] !== image.version) {
      throw coded(
        `image ${image.ref} is version ${labels[VERSION_LABEL] ?? 'unlabelled'}, the release is ${image.version}`,
        ERROR_CODES.IMAGE_MISSING,
      );
    }
  }
}
