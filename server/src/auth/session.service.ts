import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { SessionEntity } from '../history/entities';

export const SESSION_COOKIE = 'swarmloop_session';
export const SESSION_DAYS = 14;

/** The id in the session cookie of a `Cookie` header. */
export function sessionIdOf(cookieHeader: string | undefined): string | null {
  return cookieValue(cookieHeader, SESSION_COOKIE);
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      return value.join('=') || null;
    }
  }
  return null;
}

/** Login sessions: a random id, the person, and 14 days. */
@Injectable()
export class SessionService {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
  ) {}

  async create(user: string, provider: string): Promise<SessionEntity> {
    await this.sessions.delete({ expiresAt: LessThanOrEqual(this.clock.iso()) });
    const expiresAt = new Date(this.clock.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
    return this.sessions.save({ id: randomBytes(32).toString('hex'), user, provider, expiresAt });
  }

  /** The live session, or null. An expired one is deleted here. */
  async find(id: string | null): Promise<SessionEntity | null> {
    const session = id ? await this.sessions.findOneBy({ id }) : null;
    if (session && session.expiresAt <= this.clock.iso()) {
      await this.sessions.delete({ id: session.id });
      return null;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    await this.sessions.delete({ id });
  }
}
