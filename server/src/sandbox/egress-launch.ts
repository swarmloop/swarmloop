import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { EGRESS_API, type Egress, type EgressPolicy } from './egress';
import { hostName, isLocalHost } from './sandbox-launch';

export interface EgressReady {
  runtime: RuntimeName;
  allowHosts: string[];
  command: string[];
  env?: { name: string; value: string }[];
  egress?: { ip: string };
}

/**
 * The launch as it goes out behind the egress proxy: an address with its policy, and the model key swapped for a
 * placeholder where the CLI allows it. A launch without hosts keeps no network at all, and one that names a local
 * host keeps the local network, which the proxy cannot serve.
 */
export async function withEgress<T extends EgressReady>(
  egress: Pick<Egress, 'lease'>,
  launch: T,
): Promise<{ launch: T & { egress?: { ip: string } }; release: () => void }> {
  const keep = { launch, release: () => undefined };
  if (launch.allowHosts.length === 0 || launch.allowHosts.some((host) => isLocalHost(hostName(host)))) {
    return keep;
  }
  const runtime = runtimeFor(launch.runtime);
  const env: { name: string; value: string }[] = [];
  let args: string[] = [];
  let api: EgressPolicy['api'];
  for (const item of launch.env ?? []) {
    if (!runtime.credentialNames.includes(item.name)) {
      env.push(item);
      continue;
    }
    const swapped = runtime.egressCredential(item, EGRESS_API);
    env.push(...swapped.env);
    args = swapped.args ?? [];
    api = swapped.api;
  }
  const [cli, ...rest] = launch.command;
  const command = cli !== undefined && args.length > 0 ? [cli, ...args, ...rest] : launch.command;
  const lease = await egress.lease({ hosts: [...new Set(launch.allowHosts.map(hostName))], ...(api ? { api } : {}) });
  return {
    launch: { ...launch, env, command, egress: { ip: lease.ip } },
    release: lease.release,
  };
}
