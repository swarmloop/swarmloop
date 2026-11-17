import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Clock } from '../core/clock';
import type { CliLoginPoll, CliLoginView } from '../contract/people';
import { PersonalTokens } from './personal-tokens.service';

const LIFETIME_MS = 10 * 60 * 1000;
const MACHINE_LIMIT = 64;
// No 0, O, 1 or I: a code read from a screen and typed is not mistaken.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface CliLogin {
  id: string;
  code: string;
  machine: string;
  expiresAt: string;
  token: string | null;
  /** Set while the token is being made, so one code makes one token. */
  claimed: boolean;
}

function machineName(raw: string): string {
  const name = raw.trim();
  return name.length > MACHINE_LIMIT ? `${name.slice(0, MACHINE_LIMIT)}…` : name;
}

function newCode(): string {
  const chars = Array.from(randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Logins the CLI started and a person has not yet approved. In memory only: a restart drops them, and the CLI starts again. */
@Injectable()
export class CliLogins {
  private readonly logins = new Map<string, CliLogin>();

  constructor(
    private readonly clock: Clock,
    private readonly tokens: PersonalTokens,
  ) {}

  start(machine: string): CliLogin {
    this.sweep();
    const login: CliLogin = {
      id: randomBytes(32).toString('hex'),
      code: newCode(),
      machine: machineName(machine),
      expiresAt: new Date(this.clock.now() + LIFETIME_MS).toISOString(),
      token: null,
      claimed: false,
    };
    this.logins.set(login.id, login);
    return login;
  }

  /** What the approval page shows, or null for an unknown, expired or already approved code. */
  view(code: string): CliLoginView | null {
    const login = this.byCode(code);
    return login ? { machine: login.machine, expiresAt: login.expiresAt } : null;
  }

  /** Makes the CLI's token for `login`; the poll hands it out. Returns false for an unknown, expired or approved code. */
  async approve(code: string, login: string): Promise<boolean> {
    const entry = this.byCode(code);
    if (!entry) {
      return false;
    }
    entry.claimed = true;
    try {
      entry.token = (await this.tokens.create(login, `CLI on ${entry.machine}`, null)).value;
    } catch (error) {
      entry.claimed = false;
      throw error;
    }
    return true;
  }

  /** The token leaves memory with the answer that hands it out. */
  poll(id: string): CliLoginPoll {
    this.sweep();
    const login = this.logins.get(id);
    if (!login) {
      return { status: 'expired' };
    }
    if (login.token === null) {
      return { status: 'waiting' };
    }
    this.logins.delete(id);
    return { status: 'approved', token: login.token };
  }

  private byCode(code: string): CliLogin | undefined {
    this.sweep();
    const wanted = code.trim().toUpperCase();
    return [...this.logins.values()].find((login) => login.code === wanted && !login.claimed);
  }

  private sweep(): void {
    const now = this.clock.iso();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now) {
        this.logins.delete(id);
      }
    }
  }
}
