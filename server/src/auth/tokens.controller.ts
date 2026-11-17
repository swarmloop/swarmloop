import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import type {
  CliLoginView,
  CreatedTokenView,
  CreateTokenBody,
  CurrentTokenView,
  TokensView,
  TokenView,
  UseTokenBody,
} from '../contract/people';
import { Actor, ActorVia } from './actor.decorator';
import { bearerOf, type Via } from './auth.service';
import { CliLogins } from './cli-logins';
import { PersonalTokens } from './personal-tokens.service';

const LIFETIMES = [30, 90, null];

/** Only a signed-in browser session makes a token: no token can make another, and no route makes one without a person. */
function sessionPerson(actor: string | null, via: Via | null): string {
  if (!actor || via !== 'session') {
    throw new ForbiddenException('a token cannot make a token: sign in to the dashboard');
  }
  return actor;
}

function tokenPerson(actor: string | null, via: Via | null): string {
  if (!actor || via !== 'token') {
    throw new BadRequestException('only a token can do this: send it as the bearer');
  }
  return actor;
}

function checked(body: CreateTokenBody): CreateTokenBody {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    throw new BadRequestException('a token needs a name');
  }
  if (!LIFETIMES.includes(body.expiresInDays)) {
    throw new BadRequestException('expiresInDays must be 30, 90 or null');
  }
  return { name, expiresInDays: body.expiresInDays };
}

/** A person's own API tokens, and the approval of a CLI login. */
@Controller('tokens')
export class TokensController {
  constructor(
    private readonly tokens: PersonalTokens,
    private readonly logins: CliLogins,
  ) {}

  @Get()
  async list(@Actor() actor: string | null): Promise<TokensView> {
    return { tokens: await this.tokens.list(actor ?? '') };
  }

  @Post()
  create(
    @Actor() actor: string | null,
    @ActorVia() via: Via | null,
    @Body() body: CreateTokenBody,
  ): Promise<CreatedTokenView> {
    const login = sessionPerson(actor, via);
    const { name, expiresInDays } = checked(body);
    return this.tokens.create(login, name, expiresInDays);
  }

  /** A token value made elsewhere, stored under the person's name. */
  @Post('existing')
  use(@Actor() actor: string | null, @ActorVia() via: Via | null, @Body() body: UseTokenBody): Promise<TokenView> {
    const login = sessionPerson(actor, via);
    const { name, expiresInDays } = checked(body);
    return this.tokens.adopt(login, name, String(body.value ?? ''), expiresInDays);
  }

  @Get('current')
  async current(
    @Actor() actor: string | null,
    @ActorVia() via: Via | null,
    @Headers('authorization') authorization?: string,
  ): Promise<CurrentTokenView> {
    tokenPerson(actor, via);
    return this.ownToken(authorization);
  }

  @Delete('current')
  @HttpCode(204)
  async revokeCurrent(
    @Actor() actor: string | null,
    @ActorVia() via: Via | null,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    const login = tokenPerson(actor, via);
    await this.tokens.revoke(login, (await this.ownToken(authorization)).id);
  }

  @Get('cli/:code')
  viewLogin(@Param('code') code: string): CliLoginView {
    const view = this.logins.view(code);
    if (!view) {
      throw new NotFoundException('this code is unknown or has expired: start the login again');
    }
    return view;
  }

  @Post('cli/:code/approve')
  @HttpCode(204)
  async approve(
    @Actor() actor: string | null,
    @ActorVia() via: Via | null,
    @Param('code') code: string,
  ): Promise<void> {
    const login = sessionPerson(actor, via);
    if (!(await this.logins.approve(code, login))) {
      throw new NotFoundException('this code is unknown or has expired: start the login again');
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Actor() actor: string | null, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.tokens.revoke(actor ?? '', id);
  }

  private async ownToken(authorization: string | undefined): Promise<CurrentTokenView> {
    const current = await this.tokens.currentOf(bearerOf(authorization) ?? '');
    if (!current) {
      throw new NotFoundException('this token is no longer valid');
    }
    return current;
  }
}
