import { SwarmloopError } from '../core/swarmloop-error';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { CLI_BIN } from '../sandbox/cli-bundle';
import { sandboxUserId } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';

/** Whether the CLI starts in the image, and whether the image brings its own CA bundle. */
export async function runProbe(
  sandbox: Pick<SandboxService, 'run'>,
  image: string,
  cliVolume: string,
  runtime: RuntimeName,
): Promise<boolean> {
  const userId = sandboxUserId();
  const cli = `${CLI_BIN}/${runtimeFor(runtime).command}`;
  const script = `if [ -f /etc/ssl/certs/ca-certificates.crt ]; then echo certs=yes; else echo certs=no; fi; ${cli} --version`;
  let out: string;
  try {
    out = await sandbox.run(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        `${userId}:${userId}`,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777',
        '--tmpfs',
        `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${userId},gid=${userId},mode=700`,
        '--env',
        'HOME=/home/sandbox',
        '--mount',
        `type=volume,src=${cliVolume},dst=/opt/swarmloop,readonly=true`,
        '--entrypoint',
        'sh',
        image,
        '-c',
        script,
      ],
      60_000,
    );
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split('\n').slice(-3).join(' ').trim();
    throw new SwarmloopError(
      `${image}: the ${runtime} CLI does not start there (${detail}). Use a Debian or Ubuntu based image with bash; scripts/agent-env-probe.sh ${image} shows the reason.`,
    );
  }
  return out.includes('certs=yes');
}
