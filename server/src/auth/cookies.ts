import type { AppConfig } from '../config/env';
import type { LoginStates } from './login-states';
import type { ProviderName } from './oauth-provider';

export const STATE_COOKIE = 'swarmloop_state';

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
  redirect(url: string): void;
}

export function cookieOptions(config: AppConfig): Record<string, unknown> {
  return { httpOnly: true, sameSite: 'lax', secure: config.env.SWARMLOOP_PUBLIC_URL.startsWith('https:') };
}

/** Starts a login or an app: the state goes to the browser in a cookie and stays on the server for ten minutes. */
export function startState(
  states: LoginStates,
  config: AppConfig,
  provider: ProviderName,
  response: CookieResponse,
  pkce = true,
): { state: string; verifier: string } {
  const started = states.start(provider, pkce);
  response.cookie(STATE_COOKIE, started.state, { ...cookieOptions(config), path: '/auth', maxAge: 10 * 60 * 1000 });
  return started;
}
