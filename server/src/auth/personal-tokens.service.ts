import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import type { CreatedTokenView, CurrentTokenView, TokenView } from '../contract/people';
import { PersonalTokenEntity } from '../history/people-entities';

const MIN_LENGTH = 32;
const LAST_USED_EVERY_MS = 60_000;
const ENV_TOKEN_NAME = 'from SWARMLOOP_TOKEN';

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function viewOf(token: PersonalTokenEntity): TokenView {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
  };
}

/** Personal API tokens: each belongs to one person, and only its sha256 is stored. */
@Injectable()
export class PersonalTokens {
  constructor(
    private readonly clock: Clock,
    private readonly config: AppConfig,
    @InjectRepository(PersonalTokenEntity) private readonly tokens: Repository<PersonalTokenEntity>,
  ) {}

  /** Makes a token for `login`. The value is in the answer only; `expiresInDays` null means no expiry. */
  async create(login: string, name: string, expiresInDays: number | null): Promise<CreatedTokenView> {
    const value = `sl_${randomBytes(32).toString('base64url')}`;
    const saved = await this.store(login, name, value, expiresInDays);
    return { ...viewOf(saved), value };
  }

  /** Stores a token value a person made elsewhere. The same person adopting it again keeps the row. */
  async adopt(login: string, name: string, rawValue: string, expiresInDays: number | null): Promise<TokenView> {
    const value = rawValue.trim();
    if (value.length < MIN_LENGTH) {
      throw new BadRequestException(`a token needs at least ${MIN_LENGTH} characters`);
    }
    const owned = await this.tokens.findOneBy({ tokenHash: hashOf(value) });
    if (owned) {
      if (owned.login !== login) {
        throw new ConflictException('another person already owns this token');
      }
      return viewOf(owned);
    }
    return viewOf(await this.store(login, name, value, expiresInDays));
  }

  /** The login a live token acts for, or null for an unknown or expired one. */
  async personOf(value: string): Promise<string | null> {
    const token = await this.tokens.findOneBy({ tokenHash: hashOf(value) });
    if (!token || (token.expiresAt !== null && token.expiresAt <= this.clock.iso())) {
      return null;
    }
    if (!token.lastUsedAt || Date.parse(token.lastUsedAt) + LAST_USED_EVERY_MS <= this.clock.now()) {
      await this.tokens.update({ id: token.id }, { lastUsedAt: this.clock.iso() });
    }
    return token.login;
  }

  /** The id, person and name of a live token, or null for an unknown or expired one. Does not touch last used. */
  async currentOf(value: string): Promise<CurrentTokenView | null> {
    const token = await this.tokens.findOneBy({ tokenHash: hashOf(value) });
    if (!token || (token.expiresAt !== null && token.expiresAt <= this.clock.iso())) {
      return null;
    }
    return { id: token.id, login: token.login, name: token.name };
  }

  async list(login: string): Promise<TokenView[]> {
    return (await this.tokens.find({ where: { login }, order: { id: 'ASC' } })).map(viewOf);
  }

  async revoke(login: string, id: number): Promise<void> {
    await this.tokens.delete({ login, id });
  }

  /** Makes `SWARMLOOP_TOKEN` a token of `adminLogin`, unless a person owns it already. No length rule applies. */
  async adoptEnvToken(adminLogin: string): Promise<void> {
    const value = this.config.env.SWARMLOOP_TOKEN;
    if (!value || (await this.tokens.existsBy({ tokenHash: hashOf(value) }))) {
      return;
    }
    await this.store(adminLogin, ENV_TOKEN_NAME, value, null);
  }

  private store(
    login: string,
    name: string,
    value: string,
    expiresInDays: number | null,
  ): Promise<PersonalTokenEntity> {
    const expiresAt =
      expiresInDays === null ? null : new Date(this.clock.now() + expiresInDays * 24 * 3600 * 1000).toISOString();
    return this.tokens.save({
      login,
      name,
      tokenHash: hashOf(value),
      createdAt: this.clock.iso(),
      lastUsedAt: null,
      expiresAt,
    });
  }
}
