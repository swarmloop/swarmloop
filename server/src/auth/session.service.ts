import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { SessionEntity } from '../history/session.entity';

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

type Session = SessionEntity & { avatarUrl?: string };

/** Login sessions: a random id, the person, and 14 days. */
@Injectable()
export class SessionService {
  /** The avatar of each live session: no session column holds it, so it is gone after a restart. */
  private readonly avatars = new Map<string, string>();

  constructor(
    private readonly clock: Clock,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
  ) {}

  async create(user: string, provider: string, avatarUrl?: string): Promise<Session> {
    await this.sessions.delete({ expiresAt: LessThanOrEqual(this.clock.iso()) });
    const expiresAt = new Date(this.clock.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
    const session = await this.sessions.save({ id: randomBytes(32).toString('hex'), user, provider, expiresAt });
    if (avatarUrl) {
      this.avatars.set(session.id, avatarUrl);
    }
    return { ...session, avatarUrl };
  }

  /** The live session, or null. An expired one is deleted here. */
  async find(id: string | null): Promise<Session | null> {
    const session = id ? await this.sessions.findOneBy({ id }) : null;
    if (session && session.expiresAt <= this.clock.iso()) {
      await this.delete(session.id);
      return null;
    }
    return session && { ...session, avatarUrl: this.avatars.get(session.id) };
  }

  async delete(id: string): Promise<void> {
    this.avatars.delete(id);
    await this.sessions.delete({ id });
  }
}
