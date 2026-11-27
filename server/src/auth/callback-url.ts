import type { AppConfig } from '../config/env';
import type { ProviderName } from '../integrations/code-host/login-provider';

/** Where a host sends the person back after authorizing: the public URL of this server plus the host's callback route. */
export function callbackUrl(config: AppConfig, host: ProviderName): string {
  return `${config.env.SWARMLOOP_PUBLIC_URL.replace(/\/$/, '')}/auth/${host}/callback`;
}
