import type { SwarmloopEnv } from '../config/env';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const ANY = ['0.0.0.0', '::'];

type BindEnv = Pick<
  SwarmloopEnv,
  | 'SWARMLOOP_API_HOST'
  | 'SWARMLOOP_PUBLIC_URL'
  | 'GITHUB_OAUTH_CLIENT_ID'
  | 'GITHUB_OAUTH_CLIENT_SECRET'
  | 'GITLAB_OAUTH_CLIENT_ID'
  | 'GITLAB_OAUTH_CLIENT_SECRET'
>;

/**
 * Why the server must not start, or null. Without a login provider it may listen on loopback only. Compose listens
 * on 0.0.0.0 inside the container and publishes the port on 127.0.0.1, so `0.0.0.0` passes while the public URL is
 * on loopback.
 */
export function bindRefusal(env: BindEnv): string | null {
  const hasProvider =
    (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) ||
    (env.GITLAB_OAUTH_CLIENT_ID && env.GITLAB_OAUTH_CLIENT_SECRET);
  const host = env.SWARMLOOP_API_HOST.toLowerCase();
  const publicHost = new URL(env.SWARMLOOP_PUBLIC_URL).hostname.toLowerCase();
  if (hasProvider || LOOPBACK.includes(host) || (ANY.includes(host) && LOOPBACK.includes(publicHost))) {
    return null;
  }
  return `SWARMLOOP_API_HOST=${env.SWARMLOOP_API_HOST} is not loopback and no login is configured: set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET or GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET, or listen on 127.0.0.1`;
}
