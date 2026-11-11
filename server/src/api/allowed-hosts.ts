const COMPOSE_NAMES = ['server', 'dashboard'];
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** Lower-cased host name of a `Host` header, without the port. */
function hostName(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    return value.slice(0, value.indexOf(']') + 1);
  }
  return value.split(':')[0];
}

/** DNS rebinding guard: the API answers only to loopback, its public URL host and the compose names. */
export function isAllowedHost(hostHeader: string | undefined, publicUrl: string): boolean {
  if (!hostHeader) {
    return false;
  }
  const allowed = [...LOOPBACK, ...COMPOSE_NAMES, new URL(publicUrl).hostname.toLowerCase()];
  return allowed.includes(hostName(hostHeader));
}
