import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Clock } from '../core/clock';
import type { ProviderName } from './oauth-provider';

const TTL_MS = 10 * 60 * 1000;
/** Logins in flight at most: the login route is public, so the map must not grow with the calls. */
export const MAX_PENDING = 1000;

interface LoginState {
  provider: ProviderName;
  verifier: string;
  /** Set when the maker of the app started a replace: their login, or `machine`. */
  replaceBy?: string;
  /** The same-origin path the person opened before the login: the callback returns there. */
  next?: string;
}

/** The PKCE verifier of each login in flight, by `state`. They live in memory for ten minutes. */
@Injectable()
export class LoginStates {
  private readonly open = new Map<string, LoginState & { expires: number }>();

  constructor(private readonly clock: Clock) {}

  /** `pkce` false is for a code GitHub sends after an install, which no challenge was asked for: the verifier is empty. */
  start(provider: ProviderName, pkce = true, replaceBy?: string, next?: string): { state: string; verifier: string } {
    const now = this.clock.now();
    // Entries are in start order and share one TTL, so the sweep ends at the first live one.
    for (const [state, entry] of this.open) {
      if (entry.expires > now) {
        break;
      }
      this.open.delete(state);
    }
    if (this.open.size >= MAX_PENDING) {
      this.open.delete(this.open.keys().next().value as string);
    }
    const state = randomBytes(16).toString('hex');
    const verifier = pkce ? randomBytes(32).toString('base64url') : '';
    this.open.set(state, { provider, verifier, replaceBy, next, expires: now + TTL_MS });
    return { state, verifier };
  }

  /** The login for `state`, once: a second call, an unknown state or a late one answers null. */
  take(state: string): LoginState | null {
    const entry = this.open.get(state);
    this.open.delete(state);
    return entry && entry.expires > this.clock.now() ? entry : null;
  }
}
