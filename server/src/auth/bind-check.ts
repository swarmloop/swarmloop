import type { SwarmloopEnv } from '../config/env';
import type { CODE_HOST_LOGIN_ENV_KEYS } from '../config/code-host-env-keys';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const ANY = ['0.0.0.0', '::'];

/** True for a host name, or a `Host` header with a port, that is this machine. */
export function isLoopback(host: string): boolean {
  try {
    return LOOPBACK.includes(new URL(`http://${host}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

type BindEnv = Pick<
  SwarmloopEnv,
  'SWARMLOOP_API_HOST' | 'SWARMLOOP_PUBLIC_URL' | (typeof CODE_HOST_LOGIN_ENV_KEYS)[number]
>;

/**
 * Why the server must not start, or null. Without a login provider it may listen on loopback only. Compose listens
 * on 0.0.0.0 inside the container and publishes the port on 127.0.0.1, so `0.0.0.0` passes while the public URL is
 * on loopback.
 */
export function bindRefusal(env: BindEnv, storedApp = false): string | null {
  const adapters = codeHostAdapters();
  const hasProvider =
    storedApp || adapters.some(({ clientEnvKeys }) => env[clientEnvKeys.clientId] && env[clientEnvKeys.clientSecret]);
  const host = env.SWARMLOOP_API_HOST.toLowerCase();
  const publicHost = new URL(env.SWARMLOOP_PUBLIC_URL).hostname.toLowerCase();
  if (hasProvider || LOOPBACK.includes(host) || (ANY.includes(host) && LOOPBACK.includes(publicHost))) {
    return null;
  }
  const keys = adapters.map(({ clientEnvKeys }) => `${clientEnvKeys.clientId} and ${clientEnvKeys.clientSecret}`);
  const labels = adapters.map(({ label }) => label);
  return `SWARMLOOP_API_HOST=${env.SWARMLOOP_API_HOST} is not loopback and no login is configured: set ${keys.join(' or ')}, connect ${labels.join(' or ')} from the dashboard on this machine first, or listen on 127.0.0.1`;
}
