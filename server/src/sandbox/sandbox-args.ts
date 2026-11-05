import type { SandboxLaunch } from './sandbox-types';
import { EGRESS_IP, EGRESS_NETWORK, egressEnv } from './egress';

export const CLI_ROOT = '/opt/swarmloop';
const CLI_CERTS = `${CLI_ROOT}/certs/ca-certificates.crt`;

export function projectImageArgs(args: string[], launch: SandboxLaunch): void {
  const project = launch.project;
  if (!project) {
    return;
  }
  const repositories = launch.mounts.filter((mount) => mount.containerPath.endsWith('/.git'));
  if (repositories.length > 0) {
    args.push('--env', `GIT_CONFIG_COUNT=${repositories.length}`, '--env', 'GIT_OPTIONAL_LOCKS=0');
    repositories.forEach((mount, index) => {
      args.push('--env', `GIT_CONFIG_KEY_${index}=safe.directory`);
      args.push('--env', `GIT_CONFIG_VALUE_${index}=${mount.containerPath.slice(0, -5)}`);
    });
  }
  for (const cache of project.caches) {
    args.push('--mount', `type=bind,src=${cache.daemonPath},dst=${cache.containerPath},readonly=false`);
  }
  args.push('--mount', `type=volume,src=${project.cliVolume},dst=${CLI_ROOT},readonly=true`);
  args.push('--env', 'HOME=/home/sandbox', '--env', `PATH=${CLI_ROOT}/bin:${project.path}`);
  args.push('--env', `NODE_EXTRA_CA_CERTS=${CLI_CERTS}`);
  if (project.certFile) {
    args.push('--env', `SSL_CERT_FILE=${CLI_CERTS}`);
  }
}

export function egressProxyArgs(args: string[], launch: SandboxLaunch, network: string | null): void {
  if (launch.egress) {
    // Names are resolved by the proxy. Docker before 25.0.5 forwards DNS from internal networks (CVE-2024-29018),
    // so the resolver is the proxy's address, where nothing answers on port 53: a lookup fails at once on any engine.
    args.push('--network', EGRESS_NETWORK, '--ip', launch.egress.ip, '--dns', EGRESS_IP);
    for (const item of egressEnv()) {
      args.push('--env', `${item.name}=${item.value}`);
    }
  } else if (network === null) {
    args.push('--network', 'none');
  } else {
    args.push('--network', network);
    if (network === 'swarmloop-local') {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }
  }
}
